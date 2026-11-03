import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";

import { harnessThinkingOptionIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import type { HostEvent } from "@codexhost/harness-adapter";
import { describe, expect, it, vi } from "vitest";
import { mapPiSnapshot, type PiSessionHistory } from "../src/pi-history.js";
import { piMessageItemId } from "../src/pi-message-item-id.js";
import { PiAdapter } from "../src/pi-adapter.js";
import { CodexTurnProjector } from "@codexhost/protocol-core";

import {
  PiRpcSession,
  piRpcProcessCommand,
  type PiAutonomousTurn,
  type PiRpcProcessAdapter,
  type PiRpcProcessOptions,
  type PiTurnEvent,
} from "../src/pi-rpc-session.js";
import type { PiUsageObservation } from "../src/pi-usage.js";
import { piHistoryNotices } from "../src/pi-progress.js";

type Scenario =
  | "manual-run"
  | "compact-native-wire"
  | "native-id-before-text"
  | "native-id-before-reasoning"
  | "native-id-after-text"
  | "final-only"
  | "fast"
  | "fast-no-ack"
  | "fast-command-error"
  | "fast-no-off-ack"
  | "reasoning"
  | "reasoning-multiple-blocks"
  | "settled-streaming"
  | "assistant-error"
  | "retry-success"
  | "prompt-auto-compaction"
  | "prompt-preflight-compaction"
  | "prompt-preflight-compaction-timeout"
  | "manual-compaction"
  | "manual-compaction-stalled"
  | "empty"
  | "tools"
  | "long-running"
  | "cancel"
  | "cancel-no-settle"
  | "cancel-slow-settle"
  | "malformed-tool"
  | "interaction"
  | "interaction-timeout"
  | "interaction-cancel"
  | "malformed-interaction"
  | "malformed-catalog"
  | "malformed-thinking"
  | "unsupported-thinking"
  | "stats-full"
  | "stats-cache-hit"
  | "stats-context-only"
  | "stats-malformed"
  | "stats-unsupported"
  | "stats-unsupported-mismatch"
  | "stats-error"
  | "stats-timeout"
  | "stats-late"
  | "model-late"
  | "chunked-output"
  | "missing-session-id";

class FakePiRpcProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 42_000;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  fastEnabled = false;
  readonly commands: string[] = [];
  readonly commandFrames: Record<string, unknown>[] = [];
  holdEntries = false;
  holdStates = false;
  holdAborts = false;
  #heldAborts: Record<string, unknown>[] = [];
  #heldStates: Record<string, unknown>[] = [];
  #heldEntries: Record<string, unknown>[] = [];
  #buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  #promptCount = 0;
  #sessionId = "synthetic-session";
  #sessionFile: string | null = "/synthetic/session.jsonl";
  #stateRequestCount = 0;
  #isStreaming = false;
  #provider = "synthetic-provider";
  #modelId = "synthetic-model";
  #thinkingLevel = "high";
  readonly #scenario: Scenario;
  readonly #compactionDelayMs: number | undefined;

  releaseAborts(): void {
    this.holdAborts = false;
    for (const command of this.#heldAborts.splice(0)) this.#respond(command);
  }

  releaseStates(): void {
    this.holdStates = false;
    for (const command of this.#heldStates.splice(0)) this.#handle(command);
  }
  emitAgentStart(): void {
    this.#isStreaming = true;
    this.#output({ type: "agent_start" });
  }

  releaseEntries(): void {
    this.holdEntries = false;
    for (const command of this.#heldEntries.splice(0)) this.#handle(command);
  }

  restoreNativeHistory(history: PiSessionHistory, sessionId = "synthetic-session"): void {
    this.autonomousHistory = structuredClone(history);
    this.#sessionId = sessionId;
    this.#promptCount = history.entries.filter((entry) => {
      const message = entry.message as { role?: string } | undefined;
      return message?.role === "user";
    }).length;
  }

  setNativeModel(provider: string, modelId: string): void {
    this.#provider = provider;
    this.#modelId = modelId;
  }

  constructor(scenario: Scenario, compactionDelayMs?: number) {
    super();
    this.#scenario = scenario;
    if (scenario === "compact-native-wire") this.autonomousHistory = { entries: [], leafId: null };
    this.#compactionDelayMs = compactionDelayMs;
    this.stdin.on("data", (chunk: Buffer) => this.#push(chunk));
    this.stdin.once("finish", () => {
      this.exitCode = 0;
      this.stdout.end();
      this.stderr.end();
      this.emit("exit", 0, null);
    });
    queueMicrotask(() => this.emit("spawn"));
  }

  autonomousHistory: PiSessionHistory | null = null;

  emitAutonomousTurn(
    options: {
      responseId?: string | null;
      stopReason?: "stop" | "aborted" | "error";
      errorMessage?: string;
      includeTool?: boolean;
      streamingAtSettle?: boolean;
    } = {},
  ): void {
    const responseId =
      options.responseId === undefined ? "autonomous-response" : options.responseId;
    const stopReason = options.stopReason ?? "stop";
    const message = {
      role: "assistant",
      ...(responseId ? { responseId } : {}),
      timestamp: 123456,
      stopReason,
      ...(stopReason === "error"
        ? { errorMessage: options.errorMessage ?? "autonomous failure" }
        : {}),
      content: [
        { type: "thinking", thinking: "autonomous reasoning" },
        { type: "text", text: "autonomous text" },
      ],
    };
    this.autonomousHistory = {
      entries: [
        {
          id: "native-custom-entry",
          parentId: null,
          type: "custom_message",
          customType: "intercom_message",
          content: "background result",
          display: false,
        },
        { id: "native-assistant-entry", parentId: "native-custom-entry", type: "message", message },
      ],
      leafId: "native-assistant-entry",
    };
    this.#isStreaming = true;
    this.#output({ type: "message_start", message });
    this.#output({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "autonomous reasoning" },
      message,
    });
    this.#output({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "autonomous text" },
      message,
    });
    if (options.includeTool) {
      this.#output({
        type: "tool_execution_start",
        toolCallId: "autonomous-tool",
        toolName: "read",
        args: { path: "status.txt" },
      });
      this.#output({
        type: "tool_execution_update",
        toolCallId: "autonomous-tool",
        partialResult: { content: [{ type: "text", text: "working" }] },
      });
      this.#output({
        type: "tool_execution_end",
        toolCallId: "autonomous-tool",
        toolName: "read",
        result: { content: [{ type: "text", text: "done" }] },
        isError: false,
      });
    }
    this.#output({ type: "message_end", message });
    this.#isStreaming = options.streamingAtSettle === true;
    this.#output({ type: "agent_settled" });
  }

  /** Writes one raw RPC frame, for timing tests that interleave real waits. */
  emitFrame(value: unknown): void {
    this.#output(value);
  }

  emitAutonomousStart(responseId = "autonomous-pending"): void {
    this.#isStreaming = true;
    const message = {
      role: "assistant",
      responseId,
      content: [{ type: "text", text: "partial" }],
    };
    this.#output({ type: "message_start", message });
    this.#output({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "partial" },
      message,
    });
  }

  emitBlockingInteraction(): void {
    this.#output({
      type: "extension_ui_request",
      id: "autonomous-question",
      method: "select",
      title: "Blocked",
      options: ["yes", "no"],
    });
  }

  emitAgentSettled(streaming = false): void {
    this.#isStreaming = streaming;
    this.#output({ type: "agent_settled" });
  }

  #push(chunk: Buffer): void {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    let newline = this.#buffer.indexOf(0x0a);
    while (newline >= 0) {
      const frame = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      if (frame.length > 0) this.#handle(JSON.parse(frame.toString("utf8")) as unknown);
      newline = this.#buffer.indexOf(0x0a);
    }
  }

  #handle(value: unknown): void {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return;
    const command = value as Record<string, unknown>;
    if (typeof command.id !== "string" || typeof command.type !== "string") return;
    this.commands.push(command.type);
    this.commandFrames.push(command);
    if (command.type === "abort" && this.holdAborts) {
      this.#heldAborts.push(command);
      return;
    }
    if (command.type === "steer") {
      this.#respond(command, { disposition: "queued" });
      return;
    }
    if (command.type === "get_state" && this.holdStates) {
      this.#heldStates.push(command);
      return;
    }
    if (command.type === "get_entries" && this.holdEntries) {
      this.#heldEntries.push(command);
      return;
    }
    if (command.type === "extension_ui_response") {
      if (
        (this.#scenario === "interaction" &&
          command.id === "native-question" &&
          command.value === "continue") ||
        (this.#scenario === "interaction-timeout" &&
          command.id === "native-question" &&
          command.cancelled === true)
      ) {
        this.#completeInteractionTurn();
      }
      return;
    }
    if (command.type === "get_commands" && this.#scenario.startsWith("fast")) {
      this.#respond(command, {
        commands: [{ name: "codexhost-fast-mode", description: "Host Fast", source: "extension" }],
      });
      return;
    }
    if (
      command.type === "prompt" &&
      typeof command.message === "string" &&
      command.message.startsWith("/codexhost-fast-mode ")
    ) {
      const [, mode, nonce] = command.message.split(" ");
      this.fastEnabled = mode === "on";
      if (this.#scenario === "fast-command-error") {
        this.#output({
          type: "response",
          id: command.id,
          command: "prompt",
          success: false,
          error: "Extension failed after activation",
        });
        return;
      }
      if (this.#scenario === "fast" || (this.#scenario === "fast-no-off-ack" && mode === "on"))
        this.#output({
          type: "extension_ui_request",
          id: "fast-ack",
          method: "notify",
          message: `codexhost-fast-mode:${nonce}:${mode}`,
          notifyType: "info",
        });
      this.#respond(command, { disposition: "handled" });
      return;
    }
    if (command.type === "get_state") {
      this.#stateRequestCount += 1;
      this.#respond(command, {
        ...(this.#scenario === "missing-session-id" ? {} : { sessionId: this.#sessionId }),
        sessionFile: this.#sessionFile,
        model: {
          provider: this.#provider,
          id:
            this.#scenario === "stats-unsupported-mismatch" && this.#stateRequestCount > 1
              ? "changed-model"
              : this.#modelId,
          reasoning: true,
        },
        thinkingLevel: this.#thinkingLevel,
        isStreaming: this.#isStreaming,
        contextUsage: { tokens: 45, contextWindow: 200 },
      });
      return;
    }
    if (command.type === "get_session_stats") {
      if (this.#scenario === "stats-timeout") return;
      if (this.#scenario === "stats-late") {
        setTimeout(() => this.#respond(command, {}), 30);
        return;
      }
      if (
        this.#scenario === "stats-unsupported" ||
        this.#scenario === "stats-unsupported-mismatch"
      ) {
        this.#output({
          id: command.id,
          type: "response",
          command: command.type,
          success: false,
          error: `Unknown command: ${command.type}`,
        });
        return;
      }
      if (this.#scenario === "stats-error") {
        this.#output({
          id: command.id,
          type: "response",
          command: command.type,
          success: false,
          error: "Synthetic stats failure",
        });
        return;
      }
      this.#respond(
        command,
        this.#scenario === "stats-context-only"
          ? { contextUsage: { tokens: 45, contextWindow: 200 } }
          : this.#scenario === "stats-malformed"
            ? { tokens: { total: -1 }, contextUsage: { tokens: 45 } }
            : {
                tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 18 },
                cost: 0.25,
                contextUsage: { tokens: 45, contextWindow: 200 },
              },
      );
      return;
    }
    if (command.type === "get_entries") {
      if (this.autonomousHistory) {
        this.#respond(command, this.autonomousHistory);
        return;
      }
      const user = {
        id: "user-1",
        parentId: null,
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "hello" }] },
      };
      const assistant = {
        id: "assistant-1",
        parentId: "user-1",
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "answer" }],
          usage: { input: 1, output: 1, cacheRead: 999, cacheWrite: 0 },
        },
      };
      this.#respond(command, {
        entries: this.#scenario === "stats-cache-hit" ? [user, assistant] : [user],
        leafId: this.#scenario === "stats-cache-hit" ? "assistant-1" : "user-1",
      });
      return;
    }
    if (command.type === "fork" || command.type === "clone") {
      this.#sessionId = `${this.#sessionId}-derived`;
      this.#sessionFile = `${this.#sessionFile}.derived`;
      this.#respond(command);
      return;
    }
    if (command.type === "get_available_models") {
      this.#respond(command, {
        models:
          this.#scenario === "malformed-catalog"
            ? [{ id: "missing-provider", reasoning: true }]
            : [
                {
                  provider: "synthetic-provider",
                  id: "synthetic-model",
                  baseUrl: "https://private.invalid",
                  apiKey: "secret",
                  reasoning: true,
                },
                { provider: "other/provider", id: "family/model", reasoning: false },
              ],
      });
      return;
    }
    if (command.type === "get_available_thinking_levels") {
      if (this.#scenario === "unsupported-thinking") {
        this.#output({
          id: command.id,
          type: "response",
          command: command.type,
          success: false,
          error: `Unknown command: ${command.type}`,
        });
        return;
      }
      this.#respond(command, {
        levels:
          this.#scenario === "malformed-thinking"
            ? ["off", "invalid option"]
            : ["off", "low", "high"],
      });
      return;
    }
    if (command.type === "set_model") {
      if (this.#scenario === "model-late") {
        setTimeout(() => this.#respond(command), 30);
        return;
      }
      if (typeof command.provider === "string" && typeof command.modelId === "string") {
        this.#provider = command.provider;
        this.#modelId = command.modelId;
        this.#thinkingLevel = command.modelId === "family/model" ? "low" : this.#thinkingLevel;
      }
      this.#respond(command);
      return;
    }
    if (command.type === "set_thinking_level") {
      this.#thinkingLevel = ["off", "low", "high"].includes(String(command.level))
        ? String(command.level)
        : "high";
      this.#respond(command);
      return;
    }
    if (
      command.type === "compact" &&
      (this.#scenario === "manual-compaction" || this.#scenario === "manual-compaction-stalled")
    ) {
      this.#output({ type: "compaction_start", reason: "manual" });
      if (this.#scenario === "manual-compaction-stalled") return;
      setTimeout(() => {
        this.#output({
          type: "compaction_end",
          reason: "manual",
          result: {
            summary: "Synthetic manual summary",
            firstKeptEntryId: "user-1",
            tokensBefore: 275_729,
            estimatedTokensAfter: 32_000,
          },
          aborted: false,
          willRetry: false,
        });
        this.#respond(command, {
          summary: "Synthetic manual summary",
          firstKeptEntryId: "user-1",
          tokensBefore: 275_729,
          estimatedTokensAfter: 32_000,
        });
      }, this.#compactionDelayMs ?? 10);
      return;
    }
    if (
      command.type === "prompt" &&
      this.#promptCount === 0 &&
      (this.#scenario === "prompt-auto-compaction" ||
        this.#scenario === "prompt-preflight-compaction" ||
        this.#scenario === "prompt-preflight-compaction-timeout")
    ) {
      this.#promptCount += 1;
      if (this.#scenario === "prompt-auto-compaction") {
        this.#isStreaming = true;
        this.#respond(command);
      }
      this.#output({ type: "compaction_start", reason: "threshold" });
      setTimeout(() => {
        this.#output({
          type: "compaction_end",
          reason: "threshold",
          result: {
            summary: "Synthetic summary",
            firstKeptEntryId: "user-1",
            tokensBefore: 275_729,
            estimatedTokensAfter: 32_000,
          },
          aborted: false,
          willRetry: false,
        });
        if (this.#scenario === "prompt-preflight-compaction-timeout") return;
        this.#isStreaming = true;
        if (this.#scenario !== "prompt-auto-compaction") this.#respond(command);
        const message = {
          role: "assistant",
          content: [{ type: "text", text: "continued after compaction" }],
        };
        this.#output({ type: "message_start", message });
        this.#output({ type: "message_end", message });
        this.#settleAgent();
      }, this.#compactionDelayMs ?? 20);
      return;
    }
    if (command.type === "prompt") this.#isStreaming = true;
    if (
      command.type === "prompt" &&
      [
        "interaction",
        "interaction-timeout",
        "interaction-cancel",
        "malformed-interaction",
      ].includes(this.#scenario)
    ) {
      this.#startInteractionTurn(command);
      return;
    }
    if (command.type === "abort" && this.#scenario === "cancel-slow-settle") {
      // The Abort acknowledgement and settlement arrive well past the former 2s bound.
      setTimeout(() => {
        this.#respond(command);
        setTimeout(() => {
          this.#output({
            type: "tool_execution_end",
            toolCallId: "long-tool",
            toolName: "gate_long_tool",
            result: { content: [{ type: "text", text: "cancelled" }] },
            isError: true,
          });
          this.#settleAgent();
        }, 700);
      }, 2_500);
      return;
    }
    this.#respond(command);
    if (
      command.type === "abort" &&
      ["cancel", "cancel-no-settle", "interaction-cancel"].includes(this.#scenario)
    ) {
      if (this.#scenario === "cancel-no-settle") return;
      if (this.#scenario === "cancel") {
        this.#output({
          type: "tool_execution_end",
          toolCallId: "long-tool",
          toolName: "gate_long_tool",
          result: { content: [{ type: "text", text: "cancelled" }] },
          isError: true,
        });
      }
      this.#settleAgent();
      return;
    }
    if (command.type !== "prompt") return;
    this.#promptCount += 1;
    if (this.#scenario === "manual-run") return;
    if (this.#scenario === "compact-native-wire") {
      // Captured from Pi 1.4: message_update has neither message nor partial.
      const frames = JSON.parse(
        readFileSync(new URL("fixtures/pi-1.4-compact-text-stream.json", import.meta.url), "utf8"),
      ) as Record<string, unknown>[];
      const history = this.autonomousHistory;
      if (!history) throw new Error("Missing compact wire history");
      const userId = `compact-user-${this.#promptCount}`;
      const assistantId = `compact-assistant-${this.#promptCount}`;
      history.entries.push({
        id: userId,
        parentId: history.leafId,
        type: "message",
        message: { role: "user", content: String(command.message) },
      });
      for (const frame of frames) {
        const message = frame.message as Record<string, unknown> | undefined;
        if (message?.responseId) message.responseId = `${message.responseId}-${this.#promptCount}`;
        this.#output(frame);
        if (frame.type === "message_end")
          history.entries.push({
            id: assistantId,
            parentId: userId,
            type: "message",
            message: JSON.parse(JSON.stringify(message)),
          });
      }
      history.leafId = assistantId;
      this.#settleAgent();
      return;
    }
    if (this.#scenario.startsWith("native-id-")) {
      const responseId = "native-response-1";
      const firstIsReasoning = this.#scenario === "native-id-before-reasoning";
      const lateId = this.#scenario === "native-id-after-text";
      this.#output({ type: "message_start", message: { role: "assistant", content: [] } });
      this.#output({
        type: "message_update",
        message: { role: "assistant", ...(lateId ? {} : { responseId }) },
        assistantMessageEvent: {
          type: firstIsReasoning ? "thinking_delta" : "text_delta",
          delta: firstIsReasoning ? "thinking" : "ans",
        },
      });
      this.#output({
        type: "message_update",
        message: { role: "assistant", responseId },
        assistantMessageEvent: { type: "text_delta", delta: firstIsReasoning ? "answer" : "wer" },
      });
      this.#output({
        type: "message_end",
        message: {
          role: "assistant",
          responseId,
          content: [
            ...(firstIsReasoning ? [{ type: "thinking", thinking: "thinking" }] : []),
            { type: "text", text: "answer" },
          ],
        },
      });
      this.#settleAgent();
      return;
    }
    if (this.#scenario === "reasoning" || this.#scenario === "reasoning-multiple-blocks") {
      const thinkingBlocks =
        this.#scenario === "reasoning"
          ? ["streamed reasoning suffix"]
          : ["first block", "second block", "third block"];
      const message = {
        role: "assistant",
        content: [
          ...thinkingBlocks.map((thinking) => ({
            type: "thinking",
            thinking,
            thinkingSignature: "ignored",
          })),
          {
            type: "text",
            text: this.#scenario === "reasoning" ? "streamed answer suffix" : "reasoned answer",
          },
        ],
      };
      this.#output({ type: "message_start", message });
      const streamedBlocks =
        this.#scenario === "reasoning"
          ? ["streamed reasoning"]
          : ["first block", "second block", "third block"];
      for (const [contentIndex, thinking] of streamedBlocks.entries()) {
        this.#output({
          type: "message_update",
          assistantMessageEvent: { type: "thinking_delta", contentIndex, delta: thinking },
          message,
        });
        if (this.#scenario === "reasoning-multiple-blocks") {
          this.#output({
            type: "message_update",
            assistantMessageEvent: { type: "thinking_delta", contentIndex, delta: "\n\n" },
            message,
          });
        }
      }
      if (this.#scenario === "reasoning") {
        this.#output({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: thinkingBlocks.length,
            delta: "streamed answer",
          },
          message,
        });
      }
      this.#output({ type: "message_end", message });
      this.#settleAgent();
      return;
    }
    if (
      this.#scenario === "final-only" ||
      this.#scenario === "manual-compaction" ||
      this.#scenario === "prompt-auto-compaction" ||
      this.#scenario === "prompt-preflight-compaction" ||
      this.#scenario === "settled-streaming" ||
      ((this.#scenario === "cancel" ||
        this.#scenario === "cancel-slow-settle" ||
        this.#scenario === "long-running") &&
        this.#promptCount > 1)
    ) {
      const text =
        this.#scenario === "cancel" ||
        this.#scenario === "cancel-slow-settle" ||
        this.#scenario === "long-running"
          ? "continued"
          : "synthetic final text";
      const message = {
        role: "assistant",
        content: [{ type: "text", text }],
        ...(this.#scenario === "final-only"
          ? { usage: { input: 1, output: 1, cacheRead: 999, cacheWrite: 0 } }
          : {}),
      };
      this.#output({ type: "message_start", message });
      this.#output({ type: "message_end", message });
      this.#settleAgent();
      return;
    }
    if (this.#scenario === "assistant-error" || this.#scenario === "retry-success") {
      const failure = {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        stopReason: "error",
        errorMessage: '503: {"message":"Service temporarily unavailable","type":"api_error"}',
      };
      this.#output({ type: "message_start", message: failure });
      this.#output({ type: "message_end", message: failure });
      this.#output({ type: "turn_end", message: failure, toolResults: [] });
      this.#output({
        type: "agent_end",
        messages: [failure],
        willRetry: this.#scenario === "retry-success",
      });
      if (this.#scenario === "assistant-error") {
        this.#settleAgent();
        return;
      }
      this.#output({
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 0,
        errorMessage: failure.errorMessage,
      });
      const recovered = {
        role: "assistant",
        content: [{ type: "text", text: "recovered" }],
        stopReason: "stop",
      };
      this.#output({ type: "message_start", message: recovered });
      this.#output({ type: "message_end", message: recovered });
      this.#output({ type: "turn_end", message: recovered, toolResults: [] });
      this.#output({ type: "agent_end", messages: [recovered], willRetry: false });
      this.#output({ type: "auto_retry_end", success: true, attempt: 1 });
      this.#settleAgent();
      return;
    }
    if (this.#scenario === "empty") {
      this.#settleAgent();
      return;
    }
    if (this.#scenario === "malformed-tool") {
      this.#output({
        type: "tool_execution_update",
        toolCallId: "missing",
        partialResult: { content: [{ type: "text", text: "orphan" }] },
      });
      return;
    }
    if (this.#scenario === "long-running") {
      this.#output({
        type: "tool_execution_start",
        toolCallId: "long-tool",
        toolName: "gate_long_tool",
        args: {},
      });
      setTimeout(() => {
        this.#output({
          type: "tool_execution_end",
          toolCallId: "long-tool",
          toolName: "gate_long_tool",
          result: { content: [{ type: "text", text: "complete" }] },
          isError: false,
        });
        const message = {
          role: "assistant",
          content: [{ type: "text", text: "long turn complete" }],
        };
        this.#output({ type: "message_start", message });
        this.#output({ type: "message_end", message });
        this.#settleAgent();
      }, 180_001);
      return;
    }
    if (
      this.#scenario === "cancel" ||
      this.#scenario === "cancel-no-settle" ||
      this.#scenario === "cancel-slow-settle"
    ) {
      this.#output({
        type: "tool_execution_start",
        toolCallId: "long-tool",
        toolName: "gate_long_tool",
        args: {},
      });
      return;
    }
    this.#toolEvents();
  }

  #startInteractionTurn(command: Record<string, unknown>): void {
    if (this.#scenario === "malformed-interaction") {
      this.#output({
        type: "extension_ui_request",
        id: "native-question",
        method: "select",
        title: "Synthetic",
        options: [],
      });
      this.#respond(command);
      return;
    }
    this.#output({
      type: "extension_ui_request",
      id: "native-question",
      method: "select",
      title: "Synthetic",
      options: ["continue", "stop"],
      ...(this.#scenario === "interaction-timeout" ? { timeout: 10 } : {}),
    });
    this.#respond(command);
  }

  #completeInteractionTurn(): void {
    const message = { role: "assistant", content: [{ type: "text", text: "answered" }] };
    this.#output({ type: "message_start", message });
    this.#output({ type: "message_end", message });
    this.#settleAgent();
  }

  #toolEvents(): void {
    const before = {
      role: "assistant",
      responseId: "before-tools",
      content: [{ type: "text", text: "before tools" }],
    };
    this.#output({ type: "message_start", message: before });
    this.#output({ type: "message_end", message: before });
    this.#output({
      type: "tool_execution_start",
      toolCallId: "custom-1",
      toolName: "custom",
      args: { value: 1 },
    });
    this.#output({
      type: "tool_execution_start",
      toolCallId: "bash-1",
      toolName: "bash",
      args: { command: "printf done" },
    });
    this.#output({
      type: "tool_execution_update",
      toolCallId: "custom-1",
      partialResult: { content: [{ type: "text", text: "first" }] },
    });
    this.#output({
      type: "tool_execution_update",
      toolCallId: "bash-1",
      partialResult: { content: [{ type: "text", text: "done" }] },
    });
    this.#output({
      type: "tool_execution_update",
      toolCallId: "custom-1",
      partialResult: { content: [{ type: "text", text: "first second" }] },
    });
    this.#output({
      type: "tool_execution_end",
      toolCallId: "bash-1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "done" }], exitCode: 0 },
      isError: false,
    });
    this.#output({
      type: "tool_execution_end",
      toolCallId: "custom-1",
      toolName: "custom",
      result: { content: [{ type: "text", text: "first second" }] },
      isError: true,
    });
    const message = {
      role: "assistant",
      responseId: "after-tools",
      content: [{ type: "text", text: "tools complete" }],
    };
    this.#output({ type: "message_start", message });
    this.#output({ type: "message_end", message });
    this.#settleAgent();
  }

  #settleAgent(): void {
    if (this.#scenario !== "settled-streaming") this.#isStreaming = false;
    this.#output({ type: "agent_settled" });
  }

  #respond(command: Record<string, unknown>, data?: unknown): void {
    this.#output({
      id: command.id,
      type: "response",
      command: command.type,
      success: true,
      ...(data === undefined ? {} : { data }),
    });
  }

  #output(value: unknown): void {
    const frame = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    if (this.#scenario !== "chunked-output") {
      this.stdout.write(frame);
      return;
    }
    // Pipe-sized pieces: every frame arrives split across many chunks.
    for (let offset = 0; offset < frame.length; offset += 7) {
      this.stdout.write(frame.subarray(offset, offset + 7));
    }
  }
}

function session(
  scenario: Scenario,
  onFault = vi.fn(),
  options: {
    commandTimeoutMs?: number;
    nativeCompactionDelayMs?: number;
    cancelTimeoutMs?: number | "default";
  } = {},
): PiRpcSession {
  const processAdapter: PiRpcProcessAdapter = {
    spawn() {
      return new FakePiRpcProcess(
        scenario,
        options.nativeCompactionDelayMs,
      ) as unknown as ChildProcessWithoutNullStreams;
    },
  };
  return new PiRpcSession(
    {
      cwd: process.cwd(),
      commandTimeoutMs: options.commandTimeoutMs ?? 2_000,
      ...(options.cancelTimeoutMs === "default"
        ? {}
        : { cancelTimeoutMs: options.cancelTimeoutMs ?? 500 }),
      closeTimeoutMs: 500,
      onFault,
    },
    processAdapter,
  );
}

describe("Pi Fast command acknowledgement", () => {
  it("changes only Fast and keeps the confirmed state through Thinking refresh", async () => {
    const rpc = session("fast");
    await rpc.start();
    try {
      expect(await rpc.supportsFastMode()).toBe(true);
      expect(await rpc.selectFastMode(true)).toMatchObject({ fast: true, thinkingLevel: "high" });
      expect(
        await rpc.selectThinkingOption(harnessThinkingOptionIdSchema.parse("low")),
      ).toMatchObject({ fast: true, thinkingLevel: "low" });
      expect(await rpc.selectFastMode(false)).not.toHaveProperty("fast");
      expect(rpc.state.thinkingLevel).toBe("low");
    } finally {
      await rpc.close();
    }
  });
  it("clears the confirmed Fast state when a native extension switches Model", async () => {
    const process = new FakePiRpcProcess("fast");
    const rpc = new PiRpcSession(
      { cwd: "/synthetic", commandTimeoutMs: 2_000, closeTimeoutMs: 500 },
      { spawn: () => process as unknown as ChildProcessWithoutNullStreams },
    );
    await rpc.start();
    try {
      await rpc.selectFastMode(true);
      process.setNativeModel("another-provider", "unsupported");
      expect(
        await rpc.selectThinkingOption(harnessThinkingOptionIdSchema.parse("low")),
      ).not.toHaveProperty("fast");
      process.setNativeModel("synthetic-provider", "synthetic-model");
      expect(
        await rpc.selectThinkingOption(harnessThinkingOptionIdSchema.parse("high")),
      ).not.toHaveProperty("fast");
    } finally {
      await rpc.close();
    }
  });

  it.each<Scenario>(["fast-no-ack", "fast-command-error", "fast-no-off-ack"])(
    "faults and closes when request policy cannot be confirmed: %s",
    async (scenario) => {
      const process = new FakePiRpcProcess(scenario);
      const onFault = vi.fn();
      const rpc = new PiRpcSession(
        { cwd: "/synthetic", commandTimeoutMs: 2_000, closeTimeoutMs: 500, onFault },
        { spawn: () => process as unknown as ChildProcessWithoutNullStreams },
      );
      await rpc.start();
      try {
        if (scenario === "fast-no-off-ack") await rpc.selectFastMode(true);
        await expect(rpc.selectFastMode(scenario !== "fast-no-off-ack")).rejects.toThrow(
          "Fast selection could not be confirmed",
        );
        expect(onFault).toHaveBeenCalledOnce();
        expect(onFault).toHaveBeenCalledWith(expect.objectContaining({ kind: "protocolError" }));
        // The native side can already have enabled priority despite the Host-side failure.
        expect(process.fastEnabled).toBe(scenario !== "fast-no-off-ack");
        expect(process.exitCode).toBe(0);
        await expect(rpc.runTurn("must not be sent", vi.fn())).rejects.toThrow("unavailable");
        await expect(rpc.getAvailableModels()).rejects.toThrow("unavailable");
      } finally {
        await rpc.close();
      }
    },
  );
});

function autonomousSession(
  onFault = vi.fn(),
  commandTimeoutMs = 2_000,
): {
  rpc: PiRpcSession;
  process(): FakePiRpcProcess;
  onFault: ReturnType<typeof vi.fn>;
} {
  let fake: FakePiRpcProcess | null = null;
  const rpc = new PiRpcSession(
    {
      cwd: process.cwd(),
      commandTimeoutMs,
      closeTimeoutMs: 500,
      onFault,
    },
    {
      spawn() {
        fake = new FakePiRpcProcess("final-only");
        return fake as unknown as ChildProcessWithoutNullStreams;
      },
    },
  );
  return {
    rpc,
    process() {
      if (!fake) throw new Error("Fake Pi process has not started");
      return fake;
    },
    onFault,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for fake Pi event");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function appendDeferredRun(fake: FakePiRpcProcess, key: string, text: string, settle = true): void {
  const history = fake.autonomousHistory ?? { entries: [], leafId: null };
  const message = {
    role: "assistant",
    responseId: key + "-response",
    timestamp: 123457 + history.entries.length,
    content: [{ type: "text", text }],
    stopReason: "stop",
  };
  history.entries.push(
    {
      id: key,
      parentId: history.leafId,
      type: "custom_message",
      customType: "subagent:notification",
      content: "Child done",
    },
    { id: key + "-answer", parentId: key, type: "message", message },
  );
  history.leafId = key + "-answer";
  fake.autonomousHistory = history;
  fake.emitAgentStart();
  fake.emitFrame({ type: "message_start", message });
  fake.emitFrame({ type: "message_end", message });
  if (settle) fake.emitAgentSettled();
}

async function liveAutonomousHarness() {
  let fake: FakePiRpcProcess | undefined;
  const adapter = new PiAdapter(
    { closeTimeoutMs: 100 },
    {
      createTransport: (options) =>
        new PiRpcSession(
          { ...options, commandTimeoutMs: 500, cancelTimeoutMs: 100, closeTimeoutMs: 50 },
          {
            spawn: () => {
              fake = new FakePiRpcProcess("manual-run");
              fake.autonomousHistory = { entries: [], leafId: null };
              return fake as unknown as ChildProcessWithoutNullStreams;
            },
          },
        ),
    },
  );
  const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
  if (!opened.ok) throw new Error(opened.error.message);
  const session = opened.value;
  const events: HostEvent[] = [];
  const consumed = (async () => {
    for await (const output of session.outputs)
      if (output.kind === "event") events.push(output.event);
  })();
  const snapshot = await session.readSnapshot();
  if (!snapshot.ok || !fake) throw new Error("Fake native Session failed to start");
  const native = fake;
  return {
    session,
    events,
    native,
    async close() {
      await session.close();
      await adapter.close();
      await consumed;
    },
  };
}

function userTurn(id: string) {
  return {
    type: "turn.start" as const,
    turnId: hostTurnIdSchema.parse(id),
    input: [{ type: "text" as const, text: id }],
  };
}

function persistFakeRun(
  fake: FakePiRpcProcess,
  key: string,
  responseId: string,
  text: string,
  autonomous: boolean,
) {
  const history = fake.autonomousHistory ?? { entries: [], leafId: null };
  const message = {
    role: "assistant",
    responseId,
    content: [{ type: "text", text }],
    stopReason: "stop",
  };
  history.entries.push(
    autonomous
      ? {
          id: key,
          parentId: history.leafId,
          type: "custom_message",
          customType: "subagent:notification",
          display: false,
          content: "Background update",
        }
      : {
          id: key,
          parentId: history.leafId,
          type: "message",
          message: { role: "user", content: [{ type: "text", text: key }] },
        },
    { id: `${key}-answer`, parentId: key, type: "message", message },
  );
  history.leafId = `${key}-answer`;
  fake.autonomousHistory = history;
  return message;
}

describe("Pi autonomous live admission", () => {
  it.each(["agent_start", "message_start"] as const)(
    "announces autonomous %s immediately and rejects overlapping user input before dispatch",
    async (start) => {
      const harness = await liveAutonomousHarness();
      try {
        if (start === "agent_start") harness.native.emitAgentStart();
        else harness.native.emitAutonomousStart("active-autonomous");
        await waitFor(() =>
          harness.events.some((event) => event.type === "turn.autonomous.started"),
        );
        if (start === "message_start")
          expect(
            harness.events.some(
              (event) =>
                event.type === "item.updated" &&
                event.update.type === "text.append" &&
                event.update.text === "partial",
            ),
          ).toBe(true);
        expect(harness.events.filter((event) => event.type === "turn.completed")).toHaveLength(0);
        await expect(harness.session.execute(userTurn("overlap"))).resolves.toMatchObject({
          ok: false,
          error: { code: "sessionBusy", retryable: true },
        });
        expect(harness.native.commands.filter((command) => command === "prompt")).toHaveLength(0);
        expect(
          harness.events.some(
            (event) => event.type === "turn.started" && event.turnId === "overlap",
          ),
        ).toBe(false);
        const message = persistFakeRun(
          harness.native,
          "native-notice",
          "active-autonomous",
          "partial done",
          true,
        );
        if (start === "agent_start") harness.native.emitFrame({ type: "message_start", message });
        harness.native.emitFrame({ type: "message_end", message });
        harness.native.emitAgentSettled();
        await waitFor(() => harness.events.some((event) => event.type === "turn.completed"));
        expect(
          harness.events.filter((event) => event.type === "turn.autonomous.started"),
        ).toHaveLength(1);
        expect(harness.events.find((event) => event.type === "turn.completed")).toMatchObject({
          outcome: { status: "succeeded" },
          nativeTurnRef: { nativeTurnKey: "native-notice" },
        });
        await expect(
          harness.session.execute(userTurn("explicit-user-retry")),
        ).resolves.toMatchObject({ ok: true });
        expect(harness.native.commands.filter((command) => command === "prompt")).toHaveLength(1);
        const requested = persistFakeRun(
          harness.native,
          "next-user",
          "requested",
          "user answer",
          false,
        );
        harness.native.emitFrame({ type: "message_start", message: requested });
        harness.native.emitFrame({ type: "message_end", message: requested });
        harness.native.emitAgentSettled();
        await waitFor(
          () => harness.events.filter((event) => event.type === "turn.completed").length === 2,
        );
        expect(harness.events.some((event) => event.type === "session.faulted")).toBe(false);
      } finally {
        await harness.close();
      }
    },
  );

  it("arbitrates autonomous work arriving during the user history preflight", async () => {
    const harness = await liveAutonomousHarness();
    try {
      const reads = harness.native.commands.filter((command) => command === "get_entries").length;
      harness.native.holdEntries = true;
      const accepted = harness.session.execute(userTurn("race-preflight"));
      await waitFor(
        () => harness.native.commands.filter((command) => command === "get_entries").length > reads,
      );
      harness.native.emitAgentStart();
      harness.native.emitAutonomousStart("racing-autonomous");
      harness.native.releaseEntries();
      await expect(accepted).resolves.toMatchObject({
        ok: false,
        error: { code: "sessionBusy", retryable: true },
      });
      await waitFor(() => harness.events.some((event) => event.type === "turn.autonomous.started"));
      expect(harness.native.commands.filter((command) => command === "prompt")).toHaveLength(0);
      expect(
        harness.events.some(
          (event) => event.type === "turn.started" && event.turnId === "race-preflight",
        ),
      ).toBe(false);
      const message = persistFakeRun(
        harness.native,
        "racing-notice",
        "racing-autonomous",
        "partial done",
        true,
      );
      harness.native.emitFrame({ type: "message_end", message });
      harness.native.emitAgentSettled();
      await waitFor(() => harness.events.some((event) => event.type === "turn.completed"));
      expect(harness.events.some((event) => event.type === "session.faulted")).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it("streams the next deferred native run after the prior requested Host terminal without admitting another user prompt", async () => {
    const harness = await liveAutonomousHarness();
    try {
      await expect(harness.session.execute(userTurn("first-request"))).resolves.toMatchObject({
        ok: true,
      });
      const first = persistFakeRun(
        harness.native,
        "first-user",
        "first-response",
        "first complete",
        false,
      );
      harness.native.emitFrame({ type: "message_start", message: first });
      harness.native.emitFrame({ type: "message_end", message: first });
      harness.native.holdStates = true;
      harness.native.emitAgentSettled();
      appendDeferredRun(harness.native, "deferred-notice", "NEXT_AUTONOMOUS_PROGRESS", false);
      const reads = harness.native.commands.filter((command) => command === "get_entries").length;
      harness.native.holdEntries = true;
      harness.native.releaseStates();
      await waitFor(
        () => harness.native.commands.filter((command) => command === "get_entries").length > reads,
      );
      await expect(
        harness.session.execute({
          type: "turn.cancel",
          turnId: hostTurnIdSchema.parse("first-request"),
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: "invalidState" } });
      expect(harness.native.commands.filter((command) => command === "abort")).toHaveLength(0);
      harness.native.releaseEntries();
      await waitFor(() => harness.events.some((event) => event.type === "turn.autonomous.started"));
      const previousEnd = harness.events.findIndex(
        (event) => event.type === "turn.completed" && event.turnId === "first-request",
      );
      const nextStart = harness.events.findIndex(
        (event) => event.type === "turn.autonomous.started",
      );
      expect(previousEnd).toBeGreaterThanOrEqual(0);
      expect(nextStart).toBeGreaterThan(previousEnd);
      expect(
        harness.events.some(
          (event) =>
            event.type === "item.updated" &&
            event.update.type === "text.append" &&
            event.update.text === "NEXT_AUTONOMOUS_PROGRESS",
        ),
      ).toBe(true);
      await expect(harness.session.execute(userTurn("must-not-send"))).resolves.toMatchObject({
        ok: false,
        error: { code: "sessionBusy" },
      });
      expect(harness.native.commands.filter((command) => command === "prompt")).toHaveLength(1);
      harness.native.emitAgentSettled();
      await waitFor(
        () => harness.events.filter((event) => event.type === "turn.completed").length === 2,
      );
      expect(harness.events.filter((event) => event.type === "turn.completed")).toMatchObject([
        { turnId: "first-request", outcome: { status: "succeeded" } },
        { nativeTurnRef: { nativeTurnKey: "deferred-notice" }, outcome: { status: "succeeded" } },
      ]);
      expect(harness.events.some((event) => event.type === "session.faulted")).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it("cancels a visible autonomous run before its first Assistant message without faulting the Session", async () => {
    const harness = await liveAutonomousHarness();
    try {
      harness.native.emitAgentStart();
      await waitFor(() => harness.events.some((event) => event.type === "turn.autonomous.started"));
      const started = harness.events.find((event) => event.type === "turn.autonomous.started");
      if (!started || started.type !== "turn.autonomous.started")
        throw new Error("Missing autonomous start");
      await expect(
        harness.session.execute({ type: "turn.cancel", turnId: started.turnId }),
      ).resolves.toMatchObject({ ok: true });
      await expect(
        harness.session.execute(userTurn("before-cancel-settles")),
      ).resolves.toMatchObject({ ok: false, error: { code: "sessionBusy" } });
      harness.native.emitAgentSettled();
      await waitFor(() => harness.events.some((event) => event.type === "turn.completed"));
      expect(harness.events.filter((event) => event.type === "turn.completed")).toMatchObject([
        { turnId: started.turnId, outcome: { status: "cancelled" } },
      ]);
      expect(harness.events.some((event) => event.type === "session.faulted")).toBe(false);
      expect(harness.native.commands.filter((command) => command === "abort")).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it("keeps retry attempts inside one visible autonomous lifecycle", async () => {
    const harness = await liveAutonomousHarness();
    try {
      harness.native.emitAgentStart();
      const failure = {
        role: "assistant",
        responseId: "failed-attempt",
        content: [],
        stopReason: "error",
        errorMessage: "503",
      };
      harness.native.emitFrame({ type: "message_start", message: failure });
      harness.native.emitFrame({ type: "message_end", message: failure });
      harness.native.emitFrame({
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 100,
        errorMessage: "503",
      });
      harness.native.emitAgentStart();
      await waitFor(() =>
        harness.events.some(
          (event) =>
            event.type === "item.started" &&
            event.item.type === "agentMessage" &&
            event.item.text.includes("Pi retry 1/3"),
        ),
      );
      await expect(harness.session.execute(userTurn("during-retry"))).resolves.toMatchObject({
        ok: false,
        error: { code: "sessionBusy" },
      });
      const recovered = persistFakeRun(
        harness.native,
        "retry-notice",
        "recovered-attempt",
        "recovered",
        true,
      );
      const history = harness.native.autonomousHistory;
      if (!history) throw new Error("Missing history");
      history.entries.splice(1, 0, {
        id: "failed-attempt-entry",
        parentId: "retry-notice",
        type: "message",
        message: failure,
      });
      const answer = history.entries.at(-1);
      if (!answer) throw new Error("Missing answer");
      answer.parentId = "failed-attempt-entry";
      harness.native.emitFrame({ type: "message_start", message: recovered });
      harness.native.emitFrame({ type: "message_end", message: recovered });
      harness.native.emitFrame({ type: "auto_retry_end", attempt: 1, success: true });
      harness.native.emitAgentSettled();
      await waitFor(() => harness.events.some((event) => event.type === "turn.completed"));
      expect(
        harness.events.filter((event) => event.type === "turn.autonomous.started"),
      ).toHaveLength(1);
      expect(harness.events.filter((event) => event.type === "turn.completed")).toMatchObject([
        { outcome: { status: "succeeded" } },
      ]);
      expect(harness.events.some((event) => event.type === "session.faulted")).toBe(false);
      expect(harness.native.commands.filter((command) => command === "prompt")).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("records the current autonomous cancellation terminal while closing instead of waiting for a false timeout", async () => {
    const harness = await liveAutonomousHarness();
    try {
      harness.native.emitAgentStart();
      await waitFor(() => harness.events.some((event) => event.type === "turn.autonomous.started"));
      const closing = harness.session.close();
      await waitFor(() => harness.native.commands.includes("abort"));
      harness.native.emitAgentSettled();
      await closing;
      expect(harness.events.filter((event) => event.type === "turn.completed")).toMatchObject([
        { outcome: { status: "cancelled" } },
      ]);
      expect(harness.events.some((event) => event.type === "session.faulted")).toBe(false);
      expect(harness.native.exitCode).toBe(0);
    } finally {
      await harness.close();
    }
  });
});

describe("Pi RPC Turn aggregation", () => {
  it.each([
    { stopReason: "toolUse", phase: undefined, expected: "commentary" },
    { stopReason: "stop", phase: "final_answer", expected: "final_answer" },
    { stopReason: "stop", phase: "commentary", expected: "commentary" },
  ])(
    "preserves completed text phase before a trailing retry status: $stopReason/$phase",
    async ({ stopReason, phase, expected }) => {
      const fake = new FakePiRpcProcess("manual-run");
      const rpc = new PiRpcSession(
        { cwd: process.cwd(), commandTimeoutMs: 2_000, closeTimeoutMs: 500 },
        { spawn: () => fake as unknown as ChildProcessWithoutNullStreams },
      );
      await rpc.start();
      const events: PiTurnEvent[] = [];
      const pending = rpc.runTurn("synthetic", (event) => events.push(event));
      const message = {
        role: "assistant",
        responseId: "native-phase",
        content: [
          {
            type: "text",
            text: "visible",
            ...(phase ? { textSignature: JSON.stringify({ v: 1, id: "message", phase }) } : {}),
          },
        ],
        stopReason,
      };
      fake.emitFrame({ type: "message_start", message });
      fake.emitFrame({ type: "message_end", message });
      fake.emitFrame({ type: "auto_retry_end", success: true, attempt: 1 });
      fake.emitAgentSettled();
      await pending;
      expect(events).toEqual([
        expect.objectContaining({ type: "text.delta", delta: "visible" }),
        { type: "message.completed", messageId: "native-phase", phase: expected },
        expect.objectContaining({ type: "progress.message", text: "Pi retry succeeded." }),
      ]);
      await rpc.close();
    },
  );

  it("delivers a native steer into the running Turn without stopping it", async () => {
    const fake = new FakePiRpcProcess("manual-run");
    const rpc = new PiRpcSession(
      { cwd: process.cwd(), commandTimeoutMs: 2_000, closeTimeoutMs: 500 },
      { spawn: () => fake as unknown as ChildProcessWithoutNullStreams },
    );
    await rpc.start();
    try {
      const pending = rpc.runTurn("synthetic", () => undefined);
      await vi.waitFor(() => expect(fake.commands.filter((c) => c === "prompt")).toHaveLength(1));
      // The Turn is running; a native steer goes through Pi's `steer` RPC and
      // reports a queued disposition. No abort, no second prompt.
      await expect(rpc.steer("changed my mind")).resolves.toBeUndefined();
      const steer = fake.commandFrames.find((c) => c.type === "steer");
      expect(steer).toMatchObject({ message: "changed my mind" });
      expect(fake.commands.filter((c) => c === "prompt")).toHaveLength(1);
      expect(fake.commands.some((c) => c === "abort")).toBe(false);
      // The Turn settles normally afterwards.
      const message = {
        role: "assistant",
        responseId: "steered",
        content: [{ type: "text", text: "steered answer" }],
        stopReason: "stop",
      };
      fake.emitFrame({ type: "message_start", message });
      fake.emitFrame({ type: "message_end", message });
      fake.emitAgentSettled();
      await expect(pending).resolves.toMatchObject({
        text: "steered answer",
        cancelled: false,
      });
    } finally {
      await rpc.close();
    }
  });

  it("bounds idle progress without faulting, coalesces status and discloses omitted updates", async () => {
    const fake = new FakePiRpcProcess("manual-run");
    const onFault = vi.fn();
    const rpc = new PiRpcSession(
      { cwd: process.cwd(), commandTimeoutMs: 2_000, closeTimeoutMs: 500, onFault },
      { spawn: () => fake as unknown as ChildProcessWithoutNullStreams },
    );
    await rpc.start();
    for (let index = 0; index < 130; index++)
      fake.emitFrame({
        type: "extension_ui_request",
        id: `notice-${index}`,
        method: "notify",
        message: `Update ${index}`,
      });
    for (let index = 0; index < 5; index++)
      fake.emitFrame({
        type: "extension_ui_request",
        id: `status-${index}`,
        method: "setStatus",
        statusKey: "job",
        statusText: `State ${index}`,
      });
    const events: PiTurnEvent[] = [];
    const pending = rpc.runTurn("synthetic", (event) => events.push(event));
    const progress = events.filter((event) => event.type === "progress.message");
    expect(progress).toHaveLength(129);
    expect(progress[0]?.text).toContain("3 earlier updates were not retained");
    expect(progress.at(-1)?.text).toBe("Pi status (job)\n\nState 4");
    expect(progress.some((event) => event.text.includes("Update 129"))).toBe(true);
    expect(onFault).not.toHaveBeenCalled();
    const message = {
      role: "assistant",
      responseId: "final",
      content: [{ type: "text", text: "done" }],
      stopReason: "stop",
    };
    fake.emitFrame({ type: "message_start", message });
    fake.emitFrame({ type: "message_end", message });
    fake.emitAgentSettled();
    await expect(pending).resolves.toEqual({ text: "done", cancelled: false });
    await rpc.close();
  });

  it("retains idle notices and streams visible custom/status messages exactly once in a real Turn", async () => {
    const fake = new FakePiRpcProcess("manual-run");
    const events: PiTurnEvent[] = [];
    const rpc = new PiRpcSession(
      { cwd: process.cwd(), commandTimeoutMs: 2_000, closeTimeoutMs: 500 },
      {
        spawn: () => fake as unknown as ChildProcessWithoutNullStreams,
      },
    );
    await rpc.start();
    const notice = {
      role: "custom",
      customType: "ad-process:notification",
      display: true,
      content: "Process complete",
      timestamp: 100,
    };
    const send = (value: unknown) => fake.emitFrame(value);
    send({ type: "message_start", message: notice });
    send({ type: "message_end", message: notice });
    send({ type: "message_end", message: notice });
    expect(events).toEqual([]);
    const pending = rpc.runTurn("synthetic", (event) => events.push(event));
    send({ type: "message_end", message: { ...notice, timestamp: 101, display: false } });
    send({ type: "message_end", message: { ...notice, timestamp: 102 } });
    send({
      type: "extension_ui_request",
      id: "notify",
      method: "notify",
      message: "Job running",
      notifyType: "info",
    });
    send({
      type: "extension_ui_request",
      id: "status-1",
      method: "setStatus",
      statusKey: "job",
      statusText: "Waiting",
    });
    send({
      type: "extension_ui_request",
      id: "status-2",
      method: "setStatus",
      statusKey: "job",
      statusText: "Waiting",
    });
    const progress = events.filter((event) => event.type === "progress.message");
    expect(progress).toHaveLength(4);
    expect(new Set(progress.map((event) => event.itemId)).size).toBe(4);
    expect(progress.map((event) => event.text)).toEqual([
      "Pi notification (ad-process:notification)\n\nProcess complete",
      "Pi notification (ad-process:notification)\n\nProcess complete",
      "Pi notification (info)\n\nJob running",
      "Pi status (job)\n\nWaiting",
    ]);
    const message = {
      role: "assistant",
      responseId: "final",
      content: [{ type: "text", text: "done" }],
      stopReason: "stop",
    };
    send({ type: "message_start", message });
    send({ type: "message_end", message });
    fake.emitAgentSettled();
    await expect(pending).resolves.toEqual({ text: "done", cancelled: false });
    await rpc.close();
  });

  it("primes visible custom identities from the resumed native branch", async () => {
    const fake = new FakePiRpcProcess("manual-run");
    const first = {
      id: "prior-notice",
      parentId: null,
      type: "custom_message",
      customType: "progress",
      display: true,
      content: "Same text",
      timestamp: "2026-01-01T00:00:00Z",
    };
    const rpc = new PiRpcSession(
      { cwd: process.cwd(), commandTimeoutMs: 2_000, closeTimeoutMs: 500 },
      {
        spawn: () => {
          fake.restoreNativeHistory({ entries: [first], leafId: first.id });
          return fake as unknown as ChildProcessWithoutNullStreams;
        },
      },
    );
    await rpc.start();
    const events: PiTurnEvent[] = [];
    const pending = rpc.runTurn("synthetic", (event) => events.push(event));
    fake.emitFrame({
      type: "message_end",
      message: {
        role: "custom",
        customType: "progress",
        display: true,
        content: "Same text",
        timestamp: 200,
      },
    });
    const expected = piHistoryNotices("synthetic-session", [
      first,
      { ...first, id: "new-notice", timestamp: "2026-02-01T00:00:00Z" },
    ]);
    expect(events[0]).toEqual(expected.notices.get("new-notice"));
    const message = {
      role: "assistant",
      responseId: "final",
      content: [{ type: "text", text: "done" }],
      stopReason: "stop",
    };
    fake.emitFrame({ type: "message_start", message });
    fake.emitFrame({ type: "message_end", message });
    fake.emitAgentSettled();
    await pending;
    await rpc.close();
  });

  it("confirms an autonomous custom notice followed by the native empty-user wakeup", async () => {
    const { rpc, process: fake, onFault } = autonomousSession();
    const turns: PiAutonomousTurn[] = [];
    rpc.setAutonomousTurnHandler((turn) => turns.push(turn));
    await rpc.start();
    fake().holdEntries = true;
    fake().emitAutonomousTurn();
    const history = fake().autonomousHistory;
    if (!history) throw new Error("Missing history");
    const assistant = history.entries[1];
    if (!assistant) throw new Error("Missing assistant");
    assistant.parentId = "empty-wakeup";
    history.entries.splice(1, 0, {
      id: "empty-wakeup",
      parentId: "native-custom-entry",
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "" }] },
    });
    fake().releaseEntries();
    await waitFor(() => turns.length === 1);
    expect(turns[0]).toMatchObject({
      nativeTurnKey: "native-custom-entry",
      result: { status: "succeeded" },
    });
    expect(onFault).not.toHaveBeenCalled();
    await rpc.close();
  });

  it("keeps two settled generations separate when both arrive before the first state response", async () => {
    const { rpc, process: fake, onFault } = autonomousSession();
    const turns: PiAutonomousTurn[] = [];
    rpc.setAutonomousTurnHandler((turn) => turns.push(turn));
    await rpc.start();
    fake().holdStates = true;
    fake().emitAutonomousTurn();
    appendDeferredRun(fake(), "next-control", "SECOND_RUN_MARKER");
    expect(turns).toEqual([]);
    fake().releaseStates();
    await waitFor(() => turns.length === 2);
    expect(turns.map((turn) => turn.nativeTurnKey)).toEqual([
      "native-custom-entry",
      "next-control",
    ]);
    expect(turns.map((turn) => turn.result.text)).toEqual(["autonomous text", "SECOND_RUN_MARKER"]);
    expect(turns.every((turn) => turn.result.status === "succeeded")).toBe(true);
    expect(onFault).not.toHaveBeenCalled();
    await rpc.close();
  });

  it("requires an ordered new-run fence when a late get_state sees Streaming before agent_start", async () => {
    const { rpc, process: fake, onFault } = autonomousSession();
    const turns: PiAutonomousTurn[] = [];
    rpc.setAutonomousTurnHandler((turn) => turns.push(turn));
    await rpc.start();
    fake().emitAutonomousTurn({ streamingAtSettle: true });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(onFault).not.toHaveBeenCalled();
    appendDeferredRun(fake(), "deferred-control", "DEFERRED_MARKER");
    await waitFor(() => turns.length === 2);
    expect(turns.map((turn) => turn.result.text)).toEqual(["autonomous text", "DEFERRED_MARKER"]);
    expect(onFault).not.toHaveBeenCalled();
    await rpc.close();
  });

  it("keeps a late Abort acknowledgement and its timeout bound to the old requested generation", async () => {
    const fake = new FakePiRpcProcess("manual-run");
    const onFault = vi.fn();
    const rpc = new PiRpcSession(
      {
        cwd: process.cwd(),
        commandTimeoutMs: 500,
        cancelTimeoutMs: 40,
        closeTimeoutMs: 100,
        onFault,
      },
      { spawn: () => fake as unknown as ChildProcessWithoutNullStreams },
    );
    const turns: PiAutonomousTurn[] = [];
    rpc.setAutonomousTurnHandler((turn) => turns.push(turn));
    await rpc.start();
    const oldEvents: PiTurnEvent[] = [];
    const requested = rpc.runTurn("USER_STEER_OLD", (event) => oldEvents.push(event));
    fake.emitAgentStart();
    const oldMessage = {
      role: "assistant",
      responseId: "old-response",
      content: [{ type: "text", text: "OLD_MARKER" }],
      stopReason: "aborted",
    };
    fake.emitFrame({ type: "message_start", message: oldMessage });
    fake.emitFrame({ type: "message_end", message: oldMessage });
    fake.holdAborts = true;
    const aborting = rpc.abort();
    fake.emitAgentSettled();
    appendDeferredRun(fake, "after-abort", "NEW_RUN_MARKER", false);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(turns).toEqual([]);
    fake.releaseAborts();
    await aborting;
    await expect(requested).resolves.toEqual({ text: "OLD_MARKER", cancelled: true });
    expect(JSON.stringify(oldEvents)).not.toContain("NEW_RUN_MARKER");
    await new Promise((resolve) => setTimeout(resolve, 55));
    expect(onFault).not.toHaveBeenCalled();
    fake.emitAgentSettled();
    await waitFor(() => turns.length === 1);
    expect(turns[0]).toMatchObject({
      nativeTurnKey: "after-abort",
      result: { status: "succeeded", text: "NEW_RUN_MARKER" },
    });
    await rpc.close();
  });

  it("discards buffered future-generation frames and pending confirmation on close", async () => {
    const { rpc, process: fake } = autonomousSession();
    const turns: PiAutonomousTurn[] = [];
    rpc.setAutonomousTurnHandler((turn) => turns.push(turn));
    await rpc.start();
    fake().holdStates = true;
    fake().emitAutonomousTurn();
    appendDeferredRun(fake(), "never-replay", "MUST_NOT_REPLAY");
    await rpc.close();
    expect(turns).toHaveLength(1);
    expect(turns[0]?.result.status).toBe("failed");
    expect(JSON.stringify(turns)).not.toContain("MUST_NOT_REPLAY");
    expect(fake().exitCode).toBe(0);
  });

  it("faults and clears a future-generation queue that exceeds its byte bound", async () => {
    const { rpc, process: fake, onFault } = autonomousSession();
    const turns: PiAutonomousTurn[] = [];
    rpc.setAutonomousTurnHandler((turn) => turns.push(turn));
    await rpc.start();
    fake().holdStates = true;
    fake().emitAutonomousTurn();
    fake().emitAgentStart();
    fake().emitFrame({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "x".repeat(8 * 1024 * 1024) },
    });
    await waitFor(() => onFault.mock.calls.length === 1);
    expect(onFault).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Pi deferred run exceeded its event buffer bound" }),
    );
    expect(turns).toHaveLength(1);
    await rpc.close();
    expect(fake().exitCode).toBe(0);
  });

  it("fences a new-run child widget and preserves its autonomous owner across synchronous replay", async () => {
    const fake = new FakePiRpcProcess("manual-run");
    const rpc = new PiRpcSession(
      { cwd: process.cwd(), commandTimeoutMs: 500, closeTimeoutMs: 100 },
      { spawn: () => fake as unknown as ChildProcessWithoutNullStreams },
    );
    rpc.setAutonomousTurnHandler(() => undefined);
    let oldResolved = false;
    const observed: { oldResolved: boolean; owner: string; child: string | undefined }[] = [];
    rpc.setGotgenesStatusHandler((records, owner) =>
      observed.push({ oldResolved, owner, child: records[0]?.id }),
    );
    await rpc.start();
    const old = rpc
      .runTurn("requested", () => undefined)
      .then((result) => {
        oldResolved = true;
        return result;
      });
    fake.emitAgentStart();
    const before = {
      role: "assistant",
      content: [{ type: "text", text: "old turn" }],
      stopReason: "stop",
    };
    fake.emitFrame({ type: "message_start", message: before });
    fake.emitFrame({ type: "message_end", message: before });
    fake.holdStates = true;
    fake.emitAgentSettled();
    fake.emitAgentStart();
    fake.emitFrame({
      type: "message_start",
      message: { role: "assistant", content: [], responseId: "next-run" },
    });
    fake.emitFrame({
      type: "extension_ui_request",
      method: "setWidget",
      widgetKey: "codexhost-gotgenes-subagents",
      widgetLines: [
        "CODEXHOST_GOTGENES_SUBAGENTS_V1:" +
          JSON.stringify({
            version: 1,
            agents: [
              {
                id: "new-child",
                type: "Explore",
                description: "Next run child",
                status: "running",
                isBackground: true,
              },
            ],
          }),
      ],
    });
    expect(observed).toEqual([]);
    fake.releaseStates();
    await expect(old).resolves.toEqual({ text: "old turn", cancelled: false });
    expect(observed).toEqual([{ oldResolved: false, owner: "autonomous", child: "new-child" }]);
    await rpc.close();
  });

  it("receives gotgenes observer snapshots independently of parent turns and drops malformed frames", async () => {
    const { rpc, process: fakeProcess, onFault } = autonomousSession();
    await rpc.start();
    const status = vi.fn();
    const autonomous = vi.fn();
    rpc.setGotgenesStatusHandler(status);
    rpc.setAutonomousTurnHandler(autonomous);
    const send = (version: number) =>
      fakeProcess().stdout.write(
        JSON.stringify({
          type: "extension_ui_request",
          method: "setWidget",
          widgetKey: "codexhost-gotgenes-subagents",
          widgetLines: [
            "CODEXHOST_GOTGENES_SUBAGENTS_V1:" +
              JSON.stringify({
                version,
                agents: [
                  {
                    id: "worker",
                    type: "Explore",
                    description: "Review",
                    status: "completed",
                    isBackground: true,
                    toolUses: 3,
                  },
                ],
              }),
          ],
        }) + "\n",
      );
    send(2);
    expect(status).not.toHaveBeenCalled();
    send(1);
    expect(status).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          id: "worker",
          child: expect.objectContaining({ status: "completed", description: "Review" }),
        }),
      ],
      "idle",
    );
    const late = vi.fn();
    rpc.setGotgenesStatusHandler(late);
    expect(late).toHaveBeenCalledTimes(1);
    expect(autonomous).not.toHaveBeenCalled();
    expect(onFault).not.toHaveBeenCalled();
    await rpc.close();
  });

  it("observes versioned subagent widgets outside a model Turn without starting an autonomous Turn", async () => {
    const { rpc, process: fakeProcess, onFault } = autonomousSession();
    await rpc.start();
    const status = vi.fn();
    const autonomous = vi.fn();
    rpc.setSubagentStatusHandler(status);
    rpc.setAutonomousTurnHandler(autonomous);
    fakeProcess().stdout.write(
      JSON.stringify({
        type: "extension_ui_request",
        method: "setWidget",
        widgetKey: "subagent-async",
        widgetLines: [
          'PI_SUBAGENT_ASYNC_JSON:{"kind":"pi-subagents.async-status-snapshot","version":1,"runs":[{"id":"run-1","kind":"subagent","label":"worker","state":"complete"}]}',
        ],
      }) + "\n",
    );
    expect(status).toHaveBeenCalledWith([
      { id: "run-1", kind: "subagent", label: "worker", state: "complete" },
    ]);
    expect(autonomous).not.toHaveBeenCalled();
    expect(onFault).not.toHaveBeenCalled();
    await rpc.close();
  });

  it("shares pending close confirmation between concurrent callers", async () => {
    const child = new FakePiRpcProcess("final-only");
    const rpc = new PiRpcSession(
      { cwd: process.cwd(), closeTimeoutMs: 500 },
      {
        spawn: () => child as unknown as ChildProcessWithoutNullStreams,
      },
    );
    await rpc.start();
    child.stdin.removeAllListeners("finish");
    const first = rpc.close();
    let confirmed = false;
    const second = rpc.close().then(() => {
      confirmed = true;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(confirmed).toBe(false);
    } finally {
      child.exitCode = 0;
      child.stdout.end();
      child.stderr.end();
      child.emit("exit", 0, null);
      await Promise.all([first, second]);
    }
  });

  it("reports each finished assistant message with its request timing for usage metering", async () => {
    const { rpc, process: fakeProcess } = autonomousSession();
    const observations: PiUsageObservation[] = [];
    rpc.setUsageHandler((observation) => observations.push(observation));
    rpc.setAutonomousTurnHandler(() => undefined);
    await rpc.start();
    try {
      fakeProcess().emitAutonomousTurn({ includeTool: true });
      await waitFor(() => observations.length === 1);
      expect(observations[0]).toMatchObject({
        message: { role: "assistant", responseId: "autonomous-response" },
        startedAtMs: expect.any(Number),
        completedAtMs: expect.any(Number),
      });
      const [observation] = observations;
      expect(observation?.completedAtMs).toBeGreaterThanOrEqual(
        observation?.startedAtMs ?? Infinity,
      );
    } finally {
      await rpc.close();
    }
  });

  it("times a request from its first output token, excluding prefill", async () => {
    const { rpc, process: fakeProcess } = autonomousSession();
    const observations: PiUsageObservation[] = [];
    rpc.setUsageHandler((observation) => observations.push(observation));
    rpc.setAutonomousTurnHandler(() => undefined);
    await rpc.start();
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    try {
      const message = { role: "assistant", responseId: "tool-only", content: [] };
      fakeProcess().emitFrame({ type: "message_start", message });
      await sleep(120);
      // A tool-call-only reply still starts generating at its tool-call block.
      fakeProcess().emitFrame({
        type: "message_update",
        assistantMessageEvent: { type: "toolcall_start", contentIndex: 0 },
        message,
      });
      await sleep(20);
      fakeProcess().emitFrame({ type: "message_end", message });
      fakeProcess().emitAgentSettled();
      await waitFor(() => observations.length === 1);
      const [observation] = observations;
      if (!observation?.startedAtMs) throw new Error("Request timing is missing");
      expect(observation.completedAtMs - observation.startedAtMs).toBeLessThan(100);
    } finally {
      await rpc.close();
    }
  });

  it("uses the persisted custom Entry identity rather than a provider response ID", async () => {
    const { rpc, process: fakeProcess, onFault } = autonomousSession();
    const turns: PiAutonomousTurn[] = [];
    rpc.setAutonomousTurnHandler((turn) => turns.push(turn));
    await rpc.start();

    fakeProcess().emitAutonomousTurn({ includeTool: true });
    await waitFor(() => turns.length === 1);

    expect(turns[0]).toMatchObject({
      nativeTurnKey: "native-custom-entry",
      result: { status: "succeeded", text: "autonomous text" },
    });
    expect(turns[0]?.events.map(({ type }) => type)).toEqual([
      "reasoning.delta",
      "text.delta",
      "tool.started",
      "tool.updated",
      "tool.completed",
      "reasoning.completed",
      "message.completed",
    ]);
    fakeProcess().emitAgentSettled();
    await Promise.resolve();
    expect(turns).toHaveLength(1);
    expect(onFault).not.toHaveBeenCalled();
    await rpc.close();
  });

  it("keeps the native Entry key without responseId and classifies native abort", async () => {
    const { rpc, process: fakeProcess } = autonomousSession();
    const turns: PiAutonomousTurn[] = [];
    rpc.setAutonomousTurnHandler((turn) => turns.push(turn));
    await rpc.start();

    fakeProcess().emitAutonomousTurn({ responseId: null, stopReason: "aborted" });
    await waitFor(() => turns.length === 1);

    expect(turns[0]?.nativeTurnKey).toBe("native-custom-entry");
    expect(turns[0]?.result).toEqual({
      status: "cancelled",
      text: "autonomous text",
      reason: "Pi autonomous Assistant was aborted",
    });
    await rpc.close();
  });

  it("classifies Pi 1.4's error-shaped AbortSignal terminal consistently in live and history", async () => {
    const { rpc, process: fake } = autonomousSession();
    const turns: PiAutonomousTurn[] = [];
    rpc.setAutonomousTurnHandler((turn) => turns.push(turn));
    await rpc.start();
    fake().emitAutonomousTurn({ stopReason: "error", errorMessage: "This operation was aborted" });
    await waitFor(() => turns.length === 1);
    expect(turns[0]?.result.status).toBe("cancelled");
    const history = fake().autonomousHistory;
    if (!history) throw new Error("Missing history");
    expect(
      mapPiSnapshot(history, { sessionId: "synthetic-session", model: null }).turns[0]?.outcome
        .status,
    ).toBe("cancelled");
    await rpc.close();
  });

  it("does not reuse a stale autonomous history boundary", async () => {
    const { rpc, process: fakeProcess, onFault } = autonomousSession();
    const turns: PiAutonomousTurn[] = [];
    rpc.setAutonomousTurnHandler((turn) => turns.push(turn));
    await rpc.start();
    fakeProcess().emitAutonomousTurn();
    const history = fakeProcess().autonomousHistory;
    if (!history) throw new Error("Missing synthetic native history");
    const assistant = history.entries[1]?.message;
    if (!assistant || typeof assistant !== "object" || Array.isArray(assistant))
      throw new Error("Missing Assistant");
    assistant.responseId = "stale-response";
    await waitFor(() => turns.length === 1);
    expect(turns[0]).toMatchObject({ nativeTurnKey: null, result: { status: "failed" } });
    expect(onFault).toHaveBeenCalledOnce();
    await rpc.close();
  });

  it("never misclassifies a requested Turn as autonomous", async () => {
    const rpc = session("final-only");
    const autonomous = vi.fn();
    rpc.setAutonomousTurnHandler(autonomous);
    await rpc.start();

    await expect(rpc.runTurn("requested", () => undefined)).resolves.toEqual({
      text: "synthetic final text",
      cancelled: false,
    });
    expect(autonomous).not.toHaveBeenCalled();
    await rpc.close();
  });

  it("fails closed for autonomous blocking UI and streaming disagreement", async () => {
    const blocking = autonomousSession();
    const blockedTurns: PiAutonomousTurn[] = [];
    blocking.rpc.setAutonomousTurnHandler((turn) => blockedTurns.push(turn));
    await blocking.rpc.start();
    blocking.process().emitAutonomousStart();
    blocking.process().emitBlockingInteraction();
    await waitFor(() => blockedTurns.length === 1);
    expect(blockedTurns[0]?.result).toMatchObject({
      status: "failed",
      error: { message: expect.stringContaining("blocking Extension UI") },
    });
    expect(blocking.onFault).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "protocolError" }),
    );
    await blocking.rpc.close();

    const streaming = autonomousSession(vi.fn(), 50);
    const streamingTurns: PiAutonomousTurn[] = [];
    streaming.rpc.setAutonomousTurnHandler((turn) => streamingTurns.push(turn));
    await streaming.rpc.start();
    streaming.process().emitAutonomousTurn({ streamingAtSettle: true });
    await waitFor(() => streamingTurns.length === 1);
    expect(streamingTurns[0]?.result).toMatchObject({
      status: "failed",
      error: { message: expect.stringContaining("still Streaming") },
    });
    expect(streaming.onFault).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "protocolError" }),
    );
    await streaming.rpc.close();
  });

  it("reports an unfinished autonomous Turn as failed on close", async () => {
    const { rpc, process: fakeProcess } = autonomousSession();
    const turns: PiAutonomousTurn[] = [];
    rpc.setAutonomousTurnHandler((turn) => turns.push(turn));
    await rpc.start();
    fakeProcess().emitAutonomousStart();

    await rpc.close();

    expect(turns).toHaveLength(1);
    expect(turns[0]?.result).toMatchObject({
      status: "failed",
      error: { message: "Pi RPC Session closed" },
    });
  });

  it("starts the native process without a codexhost Extension option", async () => {
    const spawnProcess = vi.fn((options: PiRpcProcessOptions) => {
      expect(options.cwd).toBe(process.cwd());
      return new FakePiRpcProcess("final-only") as unknown as ChildProcessWithoutNullStreams;
    });
    const rpc = new PiRpcSession(
      {
        cwd: process.cwd(),
        commandTimeoutMs: 2_000,
        closeTimeoutMs: 500,
      },
      { spawn: spawnProcess },
    );

    await rpc.start();
    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(spawnProcess.mock.calls[0]?.[0]).not.toHaveProperty("extensionPath");
    await rpc.close();
  });

  it("adds the Host Node runtime to the Pi process PATH", async () => {
    const spawnProcess = vi.fn((options: PiRpcProcessOptions) => {
      expect(options.environment.PATH?.split(path.delimiter)).toContain(
        path.dirname(process.execPath),
      );
      return new FakePiRpcProcess("final-only") as unknown as ChildProcessWithoutNullStreams;
    });
    const rpc = new PiRpcSession(
      {
        cwd: process.cwd(),
        environment: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
        commandTimeoutMs: 2_000,
        closeTimeoutMs: 500,
      },
      { spawn: spawnProcess },
    );

    await rpc.start();
    expect(spawnProcess).toHaveBeenCalledOnce();
    await rpc.close();
  });

  it("rejects native state without stable Session identity", async () => {
    const rpc = session("missing-session-id");

    await expect(rpc.start()).rejects.toMatchObject({
      kind: "protocolError",
      message: "Pi RPC state has no stable Session identity",
    });
    await rpc.close();
  });

  it("resolves the default Windows Pi command through PATH before spawning", () => {
    const piCommand = String.raw`C:\Pi\pi.CMD`;
    const invocation = piRpcProcessCommand(
      {
        cwd: process.cwd(),
        environment: {
          PATH: String.raw`C:\missing;C:\Pi`,
          PATHEXT: ".EXE;.CMD",
          ComSpec: String.raw`C:\Windows\System32\cmd.exe`,
        },
      },
      {
        platform: "win32",
        isExecutable: (candidate) => candidate === piCommand,
      },
    );

    expect(invocation.command).toBe(String.raw`C:\Windows\System32\cmd.exe`);
    expect(invocation.arguments.slice(0, 4)).toEqual(["/d", "/v:off", "/s", "/c"]);
    expect(invocation.arguments.at(-1)).toContain(`"${piCommand}" "--mode" "rpc"`);
    expect(invocation.windowsVerbatimArguments).toBe(true);
  });

  it("finds a user npm installation when a Finder-style PATH omits it", () => {
    const piCommand = "/Users/test/.npm-global/bin/pi";
    const invocation = piRpcProcessCommand(
      {
        cwd: process.cwd(),
        environment: { HOME: "/Users/test", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      },
      {
        platform: "darwin",
        isExecutable: (candidate) => candidate === piCommand,
      },
    );

    expect(invocation.command).toBe(piCommand);
  });

  it("builds mutually exclusive Native Session resume and Fork argv", async () => {
    const options = {
      cwd: process.cwd(),
      environment: {},
      command: "/synthetic/pi",
    };
    expect(
      piRpcProcessCommand({ ...options, sessionFile: "/synthetic/source.jsonl" }),
    ).toMatchObject({
      command: "/synthetic/pi",
      arguments: ["--mode", "rpc", "--session", "/synthetic/source.jsonl"],
    });
    expect(
      piRpcProcessCommand({ ...options, forkSessionFile: "/synthetic/source.jsonl" }),
    ).toMatchObject({
      command: "/synthetic/pi",
      arguments: ["--mode", "rpc", "--fork", "/synthetic/source.jsonl"],
    });
    expect(
      piRpcProcessCommand({
        ...options,
        model: { provider: "synthetic-provider", id: "synthetic-model" },
      }),
    ).toMatchObject({
      arguments: [
        "--mode",
        "rpc",
        "--provider",
        "synthetic-provider",
        "--model",
        "synthetic-model",
      ],
    });
    expect(() =>
      piRpcProcessCommand({
        ...options,
        sessionFile: "/synthetic/resume.jsonl",
        forkSessionFile: "/synthetic/fork.jsonl",
      }),
    ).toThrow("cannot combine");
    expect(() =>
      piRpcProcessCommand({
        ...options,
        sessionFile: "/synthetic/resume.jsonl",
        model: { provider: "synthetic-provider", id: "synthetic-model" },
      }),
    ).toThrow("cannot combine");
  });

  it("passes Native resume and Fork Session files to the Pi process adapter", async () => {
    const spawnProcess = vi.fn(
      () => new FakePiRpcProcess("final-only") as unknown as ChildProcessWithoutNullStreams,
    );
    const resumed = new PiRpcSession(
      { cwd: process.cwd(), sessionFile: "/synthetic/source.jsonl" },
      { spawn: spawnProcess },
    );
    await resumed.start();
    expect(spawnProcess).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionFile: "/synthetic/source.jsonl" }),
    );
    await resumed.close();

    const forked = new PiRpcSession(
      { cwd: process.cwd(), forkSessionFile: "/synthetic/source.jsonl" },
      { spawn: spawnProcess },
    );
    await forked.start();
    expect(spawnProcess).toHaveBeenLastCalledWith(
      expect.objectContaining({ forkSessionFile: "/synthetic/source.jsonl" }),
    );
    await forked.close();
  });

  it("reads typed Entries and confirms Fork and Clone state", async () => {
    const rpc = session("final-only");
    await rpc.start();

    await expect(rpc.getEntries()).resolves.toEqual({
      entries: [expect.objectContaining({ id: "user-1", type: "message" })],
      leafId: "user-1",
    });
    await expect(rpc.fork("user-1")).resolves.toMatchObject({
      sessionId: "synthetic-session-derived",
    });
    await expect(rpc.clone()).resolves.toMatchObject({
      sessionId: "synthetic-session-derived-derived",
    });
    await rpc.close();
  });

  it("recovers final assistant text when no streaming delta was emitted", async () => {
    const rpc = session("final-only");
    const events: PiTurnEvent[] = [];
    await rpc.start();

    await expect(rpc.runTurn("synthetic", (event) => events.push(event))).resolves.toEqual({
      text: "synthetic final text",
      cancelled: false,
    });
    expect(events).toEqual([
      { type: "text.delta", messageId: expect.any(String), delta: "synthetic final text" },
      { type: "message.completed", messageId: expect.any(String) },
    ]);
    await expect(rpc.getSessionUsage()).resolves.toMatchObject({ cacheHitRatePercent: 99.9 });
    await rpc.close();
  });

  it("reconciles authoritative final suffixes without replaying streamed prefixes", async () => {
    const rpc = session("reasoning");
    const events: PiTurnEvent[] = [];
    await rpc.start();

    await expect(rpc.runTurn("synthetic", (event) => events.push(event))).resolves.toEqual({
      text: "streamed answer suffix",
      cancelled: false,
    });
    expect(events).toEqual([
      { type: "reasoning.delta", messageId: expect.any(String), delta: "streamed reasoning" },
      { type: "text.delta", messageId: expect.any(String), delta: "streamed answer" },
      { type: "reasoning.delta", messageId: expect.any(String), delta: " suffix" },
      { type: "reasoning.completed", messageId: expect.any(String) },
      { type: "text.delta", messageId: expect.any(String), delta: " suffix" },
      { type: "message.completed", messageId: expect.any(String) },
    ]);
    expect(
      new Set(events.flatMap((event) => ("messageId" in event ? [event.messageId] : []))).size,
    ).toBe(1);
    expect(JSON.stringify(events)).not.toContain("reasoned answer");
    expect(JSON.stringify(events)).not.toContain("ignored");
    await rpc.close();
  });

  it("reconciles thinking blocks by contentIndex without retaining removed summary separators", async () => {
    const rpc = session("reasoning-multiple-blocks");
    const events: PiTurnEvent[] = [];
    await rpc.start();

    await expect(rpc.runTurn("synthetic", (event) => events.push(event))).resolves.toEqual({
      text: "reasoned answer",
      cancelled: false,
    });
    expect(
      events
        .filter((event) => event.type === "reasoning.delta")
        .map(({ delta }) => delta)
        .join(""),
    ).toBe("first blocksecond blockthird block");
    expect(events.some(({ type }) => type === "reasoning.completed")).toBe(true);
    await rpc.close();
  });

  it("reconciles compact block-end events and resets each Assistant message", async () => {
    const fake = new FakePiRpcProcess("manual-run");
    const events: PiTurnEvent[] = [];
    const rpc = new PiRpcSession(
      { cwd: process.cwd(), commandTimeoutMs: 2_000, closeTimeoutMs: 500 },
      { spawn: () => fake as unknown as ChildProcessWithoutNullStreams },
    );
    await rpc.start();
    try {
      const turn = rpc.runTurn("synthetic", (event) => events.push(event));
      for (const responseId of ["first-response", "second-response"]) {
        fake.emitFrame({
          type: "message_start",
          message: { role: "assistant", responseId, content: [] },
        });
        const content = [
          { type: "thinking", thinking: "one\n\ntwo suffix" },
          { type: "text", text: "answer suffix" },
          { type: "thinking", thinking: "next" },
          { type: "text", text: " second" },
        ];
        const update = (assistantMessageEvent: Record<string, unknown>) =>
          fake.emitFrame({ type: "message_update", assistantMessageEvent });
        update({ type: "thinking_delta", contentIndex: 0, delta: "one\n\n" });
        update({ type: "thinking_delta", contentIndex: 0, delta: "two\n\n" });
        update({ type: "thinking_end", contentIndex: 0, content: content[0]?.thinking });
        update({ type: "text_delta", contentIndex: 1, delta: "answer" });
        update({ type: "text_end", contentIndex: 1, content: content[1]?.text });
        update({ type: "thinking_delta", contentIndex: 2, delta: "next\n\n" });
        update({ type: "thinking_end", contentIndex: 2, content: content[2]?.thinking });
        update({ type: "text_end", contentIndex: 3, content: content[3]?.text });
        const message = { role: "assistant", responseId, content, stopReason: "stop" };
        fake.emitFrame({ type: "message_end", message });
        fake.emitFrame({ type: "turn_end", message });
      }
      fake.emitAgentSettled();
      await expect(turn).resolves.toEqual({
        text: "answer suffix secondanswer suffix second",
        cancelled: false,
      });
      const messages = new Set(
        events.flatMap((event) => ("messageId" in event ? [event.messageId] : [])),
      );
      expect(messages.size).toBe(2);
      for (const messageId of messages) {
        expect(
          events
            .filter((event) => event.type === "reasoning.delta" && event.messageId === messageId)
            .map((event) => ("delta" in event ? event.delta : ""))
            .join(""),
        ).toBe("one\n\ntwo suffixnext");
        expect(
          events.filter(
            (event) => event.type === "message.completed" && event.messageId === messageId,
          ),
        ).toHaveLength(1);
      }
    } finally {
      await rpc.close();
    }
  });

  it("reports a protocol error when final text rewrites an already displayed prefix", async () => {
    const fake = new FakePiRpcProcess("manual-run");
    const onFault = vi.fn();
    const rpc = new PiRpcSession(
      { cwd: process.cwd(), commandTimeoutMs: 2_000, closeTimeoutMs: 500, onFault },
      { spawn: () => fake as unknown as ChildProcessWithoutNullStreams },
    );
    await rpc.start();
    try {
      const turn = rpc.runTurn("synthetic", () => undefined);
      fake.emitFrame({ type: "message_start", message: { role: "assistant", content: [] } });
      fake.emitFrame({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "original" },
      });
      fake.emitFrame({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "replacement" }],
        },
      });
      await expect(turn).rejects.toThrow(
        "Pi text final content conflicts with already streamed content",
      );
      expect(onFault).toHaveBeenCalledWith(expect.objectContaining({ kind: "protocolError" }));
    } finally {
      await rpc.close();
    }
  });

  it("faults when agent_settled does not agree with the native Streaming state", async () => {
    const onFault = vi.fn();
    const rpc = session("settled-streaming", onFault, { commandTimeoutMs: 50 });
    await rpc.start();

    await expect(rpc.runTurn("synthetic", () => undefined)).rejects.toThrow(
      "agent_settled state is still Streaming",
    );
    expect(onFault).toHaveBeenCalledWith(expect.objectContaining({ kind: "protocolError" }));
    await rpc.close();
  });

  it("correlates manual Compact RPC events without an active Prompt Turn", async () => {
    const rpc = session("manual-compaction");
    const events: PiTurnEvent[] = [];
    await rpc.start();

    await expect(
      rpc.compact("Keep implementation details", (event) => events.push(event)),
    ).resolves.toEqual({
      outcome: "succeeded",
    });
    expect(events).toEqual([
      { type: "compaction.started" },
      { type: "compaction.completed", outcome: "succeeded" },
    ]);
    await rpc.close();
  });

  it.each(["manual-compaction", "prompt-auto-compaction", "prompt-preflight-compaction"] as const)(
    "allows %s beyond the former wall-clock bound and reuses the Session",
    async (scenario) => {
      vi.useFakeTimers();
      const onFault = vi.fn();
      const durationMs = 20 * 60_000;
      const rpc = session(scenario, onFault, {
        commandTimeoutMs: 5,
        nativeCompactionDelayMs: durationMs,
      });
      const events: PiTurnEvent[] = [];
      const onSettled = vi.fn();

      try {
        await rpc.start();
        const result =
          scenario === "manual-compaction"
            ? rpc.compact(undefined, (event) => events.push(event))
            : rpc.runTurn("continue", (event) => events.push(event));
        void result.then(onSettled, onSettled);

        await vi.advanceTimersByTimeAsync(durationMs - 1);

        expect(onFault).not.toHaveBeenCalled();
        expect(onSettled).not.toHaveBeenCalled();
        expect(events).toEqual([{ type: "compaction.started" }]);

        await vi.advanceTimersByTimeAsync(1);

        await expect(result).resolves.toEqual(
          scenario === "manual-compaction"
            ? { outcome: "succeeded" }
            : { text: "continued after compaction", cancelled: false },
        );
        expect(events.filter(({ type }) => type.startsWith("compaction."))).toEqual([
          { type: "compaction.started" },
          { type: "compaction.completed", outcome: "succeeded" },
        ]);
        expect(onFault).not.toHaveBeenCalled();
        await expect(rpc.runTurn("next turn", () => undefined)).resolves.toEqual({
          text: "synthetic final text",
          cancelled: false,
        });
      } finally {
        await rpc.close();
        vi.useRealTimers();
      }
    },
  );

  it("keeps a stalled manual Compact pending until the Session closes", async () => {
    vi.useFakeTimers();
    const onFault = vi.fn();
    const onSettled = vi.fn();
    const rpc = session("manual-compaction-stalled", onFault, { commandTimeoutMs: 5 });

    try {
      await rpc.start();
      const compact = rpc.compact(undefined, () => undefined);
      void compact.then(onSettled, onSettled);

      await vi.advanceTimersByTimeAsync(20 * 60_000);

      expect(onFault).not.toHaveBeenCalled();
      expect(onSettled).not.toHaveBeenCalled();
      await rpc.close();
      await expect(compact).rejects.toThrow("Pi RPC Session closed");
    } finally {
      await rpc.close();
      vi.useRealTimers();
    }
  });

  it("keeps Prompt correlation alive while preflight auto-compaction exceeds the command timeout", async () => {
    vi.useFakeTimers();
    const onFault = vi.fn();
    const rpc = session("prompt-preflight-compaction", onFault, { commandTimeoutMs: 10 });
    const events: PiTurnEvent[] = [];

    try {
      await rpc.start();
      const result = expect(
        rpc.runTurn("continue", (event) => events.push(event)),
      ).resolves.toEqual({
        text: "continued after compaction",
        cancelled: false,
      });

      await vi.advanceTimersByTimeAsync(20);

      await result;
      expect(events.filter(({ type }) => type.startsWith("compaction."))).toEqual([
        { type: "compaction.started" },
        { type: "compaction.completed", outcome: "succeeded" },
      ]);
      expect(onFault).not.toHaveBeenCalled();
    } finally {
      await rpc.close();
      vi.useRealTimers();
    }
  });

  it("restarts the Prompt response timeout after preflight auto-compaction ends", async () => {
    vi.useFakeTimers();
    const onFault = vi.fn();
    const rpc = session("prompt-preflight-compaction-timeout", onFault, {
      commandTimeoutMs: 10,
    });

    try {
      await rpc.start();
      const turn = rpc.runTurn("continue", () => undefined);
      const rejected = expect(turn).rejects.toThrow("'prompt' command timed out");

      await vi.advanceTimersByTimeAsync(29);
      expect(onFault).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      await rejected;
      expect(onFault).toHaveBeenCalledOnce();
      expect(onFault).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "protocolError",
          message: "Pi RPC 'prompt' command timed out",
        }),
      );
      await expect(rpc.runTurn("late", () => undefined)).rejects.toThrow("unavailable");
    } finally {
      await rpc.close();
      vi.useRealTimers();
    }
  });

  it("preserves a settled Assistant error from the final Pi message", async () => {
    const rpc = session("assistant-error");
    await rpc.start();

    await expect(rpc.runTurn("synthetic", () => undefined)).rejects.toThrow(
      '503: {"message":"Service temporarily unavailable","type":"api_error"}',
    );
    await rpc.close();
  });

  it("clears a transient Assistant error when Pi auto-retry succeeds", async () => {
    const rpc = session("retry-success");
    const events: PiTurnEvent[] = [];
    await rpc.start();

    await expect(rpc.runTurn("synthetic", (event) => events.push(event))).resolves.toEqual({
      text: "recovered",
      cancelled: false,
    });
    expect(events).toEqual([
      { type: "message.completed", messageId: expect.any(String) },
      {
        type: "progress.message",
        itemId: expect.any(String),
        text: expect.stringContaining("Pi retry 1/3."),
      },
      { type: "text.delta", messageId: expect.any(String), delta: "recovered" },
      { type: "message.completed", messageId: expect.any(String), phase: "final_answer" },
      { type: "progress.message", itemId: expect.any(String), text: "Pi retry succeeded." },
    ]);
    await rpc.close();
  });

  it("rejects a settled Turn that has no displayable text, Tool, or native error", async () => {
    const rpc = session("empty");
    await rpc.start();

    await expect(rpc.runTurn("synthetic", () => undefined)).rejects.toThrow(
      "settled without displayable output",
    );
    await rpc.close();
  });

  it("matches live wire and native history IDs for the captured Pi 1.4 compact stream", async () => {
    const adapter = new PiAdapter(
      {},
      {
        createTransport: (options) =>
          new PiRpcSession(options, {
            spawn: () =>
              new FakePiRpcProcess(
                "compact-native-wire",
              ) as unknown as ChildProcessWithoutNullStreams,
          }),
      },
    );
    const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
    if (!opened.ok) throw new Error(opened.error.message);
    const session = opened.value;
    const liveIds: string[][] = [];
    try {
      const iterator = session.outputs[Symbol.asyncIterator]();
      for (const ordinal of [1, 2]) {
        const turnId = hostTurnIdSchema.parse(`compact-turn-${ordinal}`);
        const projector = new CodexTurnProjector({
          threadId: "compact-thread",
          turnId,
          cwd: "/synthetic",
          startedAtMs: 0,
        });
        await session.execute({
          type: "turn.start",
          turnId,
          input: [{ type: "text", text: "Reply exactly PI_WIRE_OK" }],
        });
        const ids = new Set<string>();
        for (;;) {
          const output = await iterator.next();
          if (output.done) throw new Error("Turn ended without completion");
          if (output.value.kind !== "event") continue;
          const event = output.value.event;
          if (
            [
              "turn.started",
              "item.started",
              "item.updated",
              "item.completed",
              "turn.completed",
            ].includes(event.type)
          ) {
            for (const notification of projector.project(
              event as Parameters<CodexTurnProjector["project"]>[0],
            ).messages) {
              if (notification.method !== "item/completed") continue;
              const params = notification.params as {
                item: { type: string; id: string; text?: string };
              };
              if (params.item.type === "agentMessage") {
                expect(params.item.text).toBe("PI_WIRE_OK");
                ids.add(params.item.id);
              }
            }
          }
          if (event.type === "turn.completed") break;
        }
        liveIds.push([...ids]);
      }
      const snapshot = await session.readSnapshot();
      if (!snapshot.ok) throw new Error(snapshot.error.message);
      expect(snapshot.value.turns.map((turn) => turn.items.map(({ item }) => item.itemId))).toEqual(
        liveIds,
      );
      expect(new Set(liveIds.flat()).size).toBe(2);
    } finally {
      await session.close();
      await adapter.close();
    }
  });

  it("does not place a history-read gap between accepting a Turn and dispatching its cancellable prompt", async () => {
    const process = new FakePiRpcProcess("compact-native-wire");
    const rpc = new PiRpcSession(
      { cwd: "/synthetic", commandTimeoutMs: 100 },
      {
        spawn: () => process as unknown as ChildProcessWithoutNullStreams,
      },
    );
    await rpc.start();
    process.holdEntries = true;
    try {
      const running = rpc.runTurn("Reply exactly PI_WIRE_OK", () => undefined);
      const cancelling = rpc.abort();
      process.releaseEntries();
      await cancelling;
      await expect(running).resolves.toMatchObject({ cancelled: true });
      expect(process.commands.indexOf("prompt")).toBeLessThan(process.commands.indexOf("abort"));
    } finally {
      process.releaseEntries();
      await rpc.close();
    }
  });

  it("rebuilds compact-stream identities from persisted tool/error messages on cold resume and branch rollback", async () => {
    const timestamp = 1792994079878; // The timestamp in the captured compact RPC fixture.
    const seed: PiSessionHistory = {
      entries: [
        {
          id: "seed-user",
          parentId: null,
          type: "message",
          message: { role: "user", content: "seed" },
        },
        {
          id: "seed-tool",
          parentId: "seed-user",
          type: "message",
          message: {
            role: "assistant",
            timestamp,
            stopReason: "toolUse",
            content: [{ type: "toolCall", id: "tool", name: "read", arguments: { path: "x" } }],
          },
        },
        {
          id: "seed-error",
          parentId: "seed-tool",
          type: "message",
          message: { role: "assistant", timestamp, stopReason: "error", content: [] },
        },
        {
          id: "seed-answer",
          parentId: "seed-error",
          type: "message",
          message: {
            role: "assistant",
            timestamp,
            stopReason: "stop",
            content: [{ type: "text", text: "old" }],
          },
        },
      ],
      leafId: "seed-answer",
    };
    const create = (history: PiSessionHistory, sessionId?: string) => {
      const process = new FakePiRpcProcess("compact-native-wire");
      process.restoreNativeHistory(history, sessionId);
      const rpc = new PiRpcSession(
        { cwd: "/synthetic", commandTimeoutMs: 100 },
        {
          spawn: () => process as unknown as ChildProcessWithoutNullStreams,
        },
      );
      return { process, rpc };
    };
    const run = async (rpc: PiRpcSession, occurrence: number) => {
      const events: PiTurnEvent[] = [];
      await rpc.runTurn("Reply exactly PI_WIRE_OK", (event) => events.push(event));
      const delta = events.find((event) => event.type === "text.delta");
      if (!delta || delta.type !== "text.delta") throw new Error("Missing native delta");
      expect(delta.nativeMessageIdentity).toEqual({
        sessionId: rpc.state.sessionId,
        timestamp,
        occurrence,
      });
      const id = piMessageItemId(delta.nativeMessageIdentity, "assistant");
      const history = await rpc.getEntries();
      const snapshot = mapPiSnapshot(history, { sessionId: rpc.state.sessionId, model: null });
      expect(snapshot.turns.at(-1)?.items.at(-1)?.item.itemId).toBe(id);
      return { id, history };
    };
    const first = create(seed);
    await first.rpc.start();
    let persisted: PiSessionHistory;
    try {
      persisted = (await run(first.rpc, 3)).history;
    } finally {
      await first.rpc.close();
    }
    const cold = create(persisted);
    await cold.rpc.start();
    try {
      await run(cold.rpc, 4);
      // The inactive descendants remain in the file, but no longer in the branch.
      cold.process.restoreNativeHistory({ ...persisted, leafId: "seed-tool" });
      // The Adapter reads the new branch before accepting the next Turn.
      await cold.rpc.getEntries();
      await run(cold.rpc, 1);
    } finally {
      await cold.rpc.close();
    }
    const fork = create(seed, "forked-native-session");
    await fork.rpc.start();
    try {
      const { id } = await run(fork.rpc, 3);
      expect(id).not.toBe(
        piMessageItemId({ sessionId: "synthetic-session", timestamp, occurrence: 3 }, "assistant"),
      );
    } finally {
      await fork.rpc.close();
    }
  });

  it.each(["native-id-before-text", "native-id-before-reasoning"] as const)(
    "adopts a native responseId before the first visible delta (%s)",
    async (scenario) => {
      const rpc = session(scenario);
      const events: PiTurnEvent[] = [];
      await rpc.start();
      await rpc.runTurn("synthetic", (event) => events.push(event));
      const visible = events.filter(
        (event) => event.type === "text.delta" || event.type === "reasoning.delta",
      );
      expect(visible.length).toBeGreaterThan(0);
      expect(visible.map((event) => event.messageId)).toEqual(
        visible.map(() => "native-response-1"),
      );
      expect(
        visible.every(
          (event) =>
            event.nativeMessageIdentity &&
            "responseId" in event.nativeMessageIdentity &&
            event.nativeMessageIdentity.responseId === "native-response-1",
        ),
      ).toBe(true);
      await rpc.close();
    },
  );

  it("does not change a message identity after a visible delta", async () => {
    const rpc = session("native-id-after-text");
    const events: PiTurnEvent[] = [];
    await rpc.start();
    await rpc.runTurn("synthetic", (event) => events.push(event));
    const visible = events.filter((event) => event.type === "text.delta");
    expect(visible).toHaveLength(2);
    expect(visible[0]?.messageId).not.toBe("native-response-1");
    expect(visible[1]?.messageId).toBe(visible[0]?.messageId);
    expect(visible.every((event) => event.nativeMessageIdentity === undefined)).toBe(true);
    await rpc.close();
  });

  it("validates and correlates interleaved Tool lifecycles", async () => {
    const rpc = session("tools");
    const events: PiTurnEvent[] = [];
    await rpc.start();

    await expect(rpc.runTurn("synthetic", (event) => events.push(event))).resolves.toMatchObject({
      text: "before toolstools complete",
      cancelled: false,
    });
    expect(events.map(({ type }) => type)).toEqual([
      "text.delta",
      "message.completed",
      "tool.started",
      "tool.started",
      "tool.updated",
      "tool.updated",
      "tool.updated",
      "tool.completed",
      "tool.completed",
      "text.delta",
      "message.completed",
    ]);
    const textEvents = events.filter((event) => event.type === "text.delta");
    expect(textEvents).toEqual([
      {
        type: "text.delta",
        messageId: "before-tools",
        nativeMessageIdentity: { responseId: "before-tools" },
        delta: "before tools",
      },
      {
        type: "text.delta",
        messageId: "after-tools",
        nativeMessageIdentity: { responseId: "after-tools" },
        delta: "tools complete",
      },
    ]);
    expect(
      events.filter((event) => event.type === "tool.updated" && event.callId === "custom-1"),
    ).toMatchObject([
      { output: { content: [{ text: "first" }] } },
      { output: { content: [{ text: "first second" }] } },
    ]);
    await rpc.close();
  });

  it("reads only exact native Model identity and confirms selection through state", async () => {
    const rpc = session("final-only");
    await rpc.start();

    await expect(rpc.getAvailableModels()).resolves.toEqual([
      { provider: "synthetic-provider", id: "synthetic-model", reasoning: true },
      { provider: "other/provider", id: "family/model", reasoning: false },
    ]);
    await expect(
      rpc.selectModel({ provider: "other/provider", id: "family/model" }),
    ).resolves.toMatchObject({ provider: "other/provider", modelId: "family/model" });
    expect(rpc.state).toMatchObject({
      provider: "other/provider",
      modelId: "family/model",
      modelReasoning: true,
    });
    await rpc.close();
  });

  it("reads strict Session Usage and degrades only an explicit unsupported command", async () => {
    const complete = session("stats-full");
    await complete.start();
    await expect(complete.getSessionUsage()).resolves.toEqual({
      inputTokens: 10,
      cachedInputTokens: 2,
      cacheWriteInputTokens: 1,
      outputTokens: 5,
      totalTokens: 18,
      totalCostUsd: 0.25,
      contextUsedTokens: 45,
      contextWindowTokens: 200,
    });
    await complete.close();

    const cacheHit = session("stats-cache-hit");
    await cacheHit.start();
    await expect(cacheHit.getSessionUsage()).resolves.toMatchObject({
      cacheHitRatePercent: 99.9,
    });
    await cacheHit.close();

    const contextOnly = session("stats-context-only");
    await contextOnly.start();
    await expect(contextOnly.getSessionUsage()).resolves.toEqual({
      contextUsedTokens: 45,
      contextWindowTokens: 200,
    });
    await contextOnly.close();

    const unsupported = session("stats-unsupported");
    await unsupported.start();
    await expect(unsupported.getSessionUsage()).resolves.toEqual({
      contextUsedTokens: 45,
      contextWindowTokens: 200,
    });
    await unsupported.close();

    const mismatch = session("stats-unsupported-mismatch");
    await mismatch.start();
    await expect(mismatch.getSessionUsage()).rejects.toThrow("confirmed Session state");
    await mismatch.close();
  });

  it("keeps malformed, timeout, and non-unsupported stats failures local to Telemetry", async () => {
    for (const scenario of ["stats-malformed", "stats-error"] as const) {
      const onFault = vi.fn();
      const rpc = session(scenario, onFault);
      await rpc.start();
      await expect(rpc.getSessionUsage()).rejects.toThrow();
      expect(onFault).not.toHaveBeenCalled();
      await expect(rpc.getAvailableModels()).resolves.toHaveLength(2);
      await rpc.close();
    }

    const onFault = vi.fn();
    const timedOut = session("stats-timeout", onFault, { commandTimeoutMs: 10 });
    await timedOut.start();
    await expect(timedOut.getSessionUsage()).rejects.toThrow("command timed out");
    expect(onFault).not.toHaveBeenCalled();
    await timedOut.close();

    // Pi answering after the Host gave up must not fault the Session.
    const lateFault = vi.fn();
    const late = session("stats-late", lateFault, { commandTimeoutMs: 10 });
    await late.start();
    await expect(late.getSessionUsage()).rejects.toThrow("command timed out");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(lateFault).not.toHaveBeenCalled();
    await expect(late.getAvailableModels()).resolves.toHaveLength(2);
    await late.close();
  });

  it("remembers a bounded number of expired ids", async () => {
    for (const [count, faults] of [
      [64, false],
      [65, true],
    ] as const) {
      const onFault = vi.fn();
      const rpc = session("stats-late", onFault, { commandTimeoutMs: 10 });
      await rpc.start();
      const usages = Array.from({ length: count }, () => rpc.getSessionUsage());
      for (const usage of usages) await expect(usage).rejects.toThrow("command timed out");
      await new Promise((resolve) => setTimeout(resolve, 150));
      // Past the bound the oldest id is forgotten, so its late answer is an unknown id.
      if (faults) {
        expect(onFault).toHaveBeenCalledWith(
          expect.objectContaining({ message: "Pi RPC response id is not pending" }),
        );
      } else {
        expect(onFault).not.toHaveBeenCalled();
      }
      await rpc.close();
    }
  });

  it("still faults on a late answer to a timed-out state-changing command", async () => {
    // Pi may have applied the change after the Host gave up, so its state is unconfirmed.
    const onFault = vi.fn();
    const rpc = session("model-late", onFault, { commandTimeoutMs: 10 });
    await rpc.start();
    await expect(
      rpc.selectModel({ provider: "synthetic-provider", id: "family/model" }),
    ).rejects.toThrow("command timed out");
    await vi.waitFor(() =>
      expect(onFault).toHaveBeenCalledWith(
        expect.objectContaining({ message: "Pi RPC response id is not pending" }),
      ),
    );
    await rpc.close();
  });

  it("assembles frames split across many stdout chunks", async () => {
    const plain = session("final-only");
    const chunked = session("chunked-output");
    await plain.start();
    await chunked.start();
    await expect(chunked.getEntries()).resolves.toEqual(await plain.getEntries());
    await plain.close();
    await chunked.close();
  });

  it("reads actual Thinking options and corrected state after selection", async () => {
    const rpc = session("final-only");
    await rpc.start();

    await expect(rpc.getAvailableThinkingLevels()).resolves.toEqual(["off", "low", "high"]);
    await expect(
      rpc.selectThinkingOption(harnessThinkingOptionIdSchema.parse("xhigh")),
    ).resolves.toMatchObject({ thinkingLevel: "high" });
    expect(rpc.state.thinkingLevel).toBe("high");
    await rpc.close();
  });

  it("degrades only an explicit unknown Thinking command and faults malformed levels", async () => {
    const unsupported = session("unsupported-thinking");
    await unsupported.start();
    await expect(unsupported.getAvailableThinkingLevels()).resolves.toBeNull();
    await expect(unsupported.getAvailableModels()).resolves.toHaveLength(2);
    await unsupported.close();

    const onFault = vi.fn();
    const malformed = session("malformed-thinking", onFault);
    await malformed.start();
    await expect(malformed.getAvailableThinkingLevels()).rejects.toThrow("invalid level");
    expect(onFault).toHaveBeenCalledWith(expect.objectContaining({ kind: "protocolError" }));
    await malformed.close();
  });

  it("faults a malformed native Model catalog", async () => {
    const onFault = vi.fn();
    const rpc = session("malformed-catalog", onFault);
    await rpc.start();

    await expect(rpc.getAvailableModels()).rejects.toThrow("invalid catalog Model");
    expect(onFault).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "protocolError",
        message: "Pi RPC returned an invalid catalog Model",
      }),
    );
    await rpc.close();
  });

  it("waits for Abort acknowledgement and agent settlement before resolving cancelled", async () => {
    const rpc = session("cancel");
    const events: PiTurnEvent[] = [];
    await rpc.start();

    const turn = rpc.runTurn("cancel me", (event) => events.push(event));
    await waitFor(() => events.some(({ type }) => type === "tool.started"));
    await expect(Promise.all([rpc.abort(), rpc.abort()])).resolves.toEqual([undefined, undefined]);
    await expect(turn).resolves.toEqual({ text: "", cancelled: true });
    expect(events.at(-1)).toMatchObject({ type: "tool.completed", isError: true });

    await expect(rpc.runTurn("continue", (event) => events.push(event))).resolves.toEqual({
      text: "continued",
      cancelled: false,
    });
    await rpc.close();
  });

  it("settles a cancellation whose Abort acknowledgement is slower than the former bound", async () => {
    vi.useFakeTimers();
    const onFault = vi.fn();
    const rpc = session("cancel-slow-settle", onFault, {
      commandTimeoutMs: 30_000,
      cancelTimeoutMs: "default",
    });
    const events: PiTurnEvent[] = [];

    try {
      await rpc.start();
      const turn = rpc.runTurn("cancel me slowly", (event) => events.push(event));
      for (
        let attempt = 0;
        attempt < 10 && !events.some(({ type }) => type === "tool.started");
        attempt += 1
      ) {
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(events.some(({ type }) => type === "tool.started")).toBe(true);

      const aborting = rpc.abort();
      await vi.advanceTimersByTimeAsync(2_001);
      expect(onFault).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_200);
      await expect(aborting).resolves.toBeUndefined();
      await expect(turn).resolves.toEqual({ text: "", cancelled: true });
      expect(onFault).not.toHaveBeenCalled();

      await expect(rpc.runTurn("continue", (event) => events.push(event))).resolves.toEqual({
        text: "continued",
        cancelled: false,
      });
      await rpc.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails and closes a cancellation that does not reach stable settlement", async () => {
    vi.useFakeTimers();
    const onFault = vi.fn();
    const rpc = session("cancel-no-settle", onFault, { cancelTimeoutMs: 10 });

    try {
      await rpc.start();
      const turn = rpc.runTurn("cancel me", () => undefined);
      const rejected = expect(turn).rejects.toThrow(
        "Pi Turn cancellation did not settle within its bound",
      );
      await rpc.abort();

      await vi.advanceTimersByTimeAsync(10);

      await rejected;
      expect(onFault).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "protocolError",
          message: "Pi Turn cancellation did not settle within its bound",
        }),
      );
      await expect(rpc.runTurn("unavailable", () => undefined)).rejects.toThrow("unavailable");
    } finally {
      await rpc.close();
      vi.useRealTimers();
    }
  });

  it("round-trips an Interaction that arrives before the Prompt response", async () => {
    const rpc = session("interaction");
    const events: PiTurnEvent[] = [];
    await rpc.start();

    const turn = rpc.runTurn("ask", (event) => events.push(event));
    await waitFor(() => events.some(({ type }) => type === "interaction.requested"));
    expect(events[0]).toMatchObject({
      type: "interaction.requested",
      request: {
        requestId: "native-question",
        method: "select",
        options: ["continue", "stop"],
      },
    });
    await expect(
      rpc.respondToInteraction({ requestId: "native-question", value: "continue" }),
    ).resolves.toBeUndefined();
    await expect(turn).resolves.toEqual({ text: "answered", cancelled: false });
    expect(events.map(({ type }) => type)).toEqual([
      "interaction.requested",
      "interaction.closed",
      "text.delta",
      "message.completed",
    ]);
    expect(events[1]).toMatchObject({ type: "interaction.closed", reason: "responded" });
    await rpc.close();
  });

  it("expires a native Interaction and rejects its late response", async () => {
    const rpc = session("interaction-timeout");
    const events: PiTurnEvent[] = [];
    await rpc.start();

    const turn = rpc.runTurn("expire", (event) => events.push(event));
    await waitFor(() =>
      events.some((event) => event.type === "interaction.closed" && event.reason === "expired"),
    );
    await expect(
      rpc.respondToInteraction({ requestId: "native-question", value: "late" }),
    ).rejects.toThrow("not pending");
    await expect(turn).resolves.toEqual({ text: "answered", cancelled: false });
    expect(
      events.filter(
        (event) => event.type === "interaction.closed" && event.requestId === "native-question",
      ),
    ).toHaveLength(1);
    await rpc.close();
  });

  it("closes a pending Interaction before a cancelled Turn settles", async () => {
    const rpc = session("interaction-cancel");
    const events: PiTurnEvent[] = [];
    await rpc.start();

    const turn = rpc.runTurn("cancel question", (event) => events.push(event));
    await waitFor(() => events.some(({ type }) => type === "interaction.requested"));
    await rpc.abort();
    await expect(turn).resolves.toEqual({ text: "", cancelled: true });
    expect(events.at(-1)).toMatchObject({
      type: "interaction.closed",
      reason: "cancelled",
    });
    await rpc.close();
  });

  it("faults malformed blocking Interaction input", async () => {
    const onFault = vi.fn();
    const rpc = session("malformed-interaction", onFault);
    await rpc.start();

    await expect(rpc.runTurn("malformed", () => undefined)).rejects.toThrow(
      "select request has invalid options",
    );
    expect(onFault).toHaveBeenCalledWith(expect.objectContaining({ kind: "protocolError" }));
    await rpc.close();
  });

  it("allows a Tool Turn to run beyond the former wall-clock bound", async () => {
    vi.useFakeTimers();
    const onFault = vi.fn();
    const rpc = session("long-running", onFault);
    const events: PiTurnEvent[] = [];

    try {
      await rpc.start();
      const turn = rpc.runTurn("long task", (event) => events.push(event));

      await vi.advanceTimersByTimeAsync(180_001);

      await expect(turn).resolves.toEqual({ text: "long turn complete", cancelled: false });
      expect(events.map(({ type }) => type)).toEqual([
        "tool.started",
        "tool.completed",
        "text.delta",
        "message.completed",
      ]);
      expect(onFault).not.toHaveBeenCalled();
      await expect(rpc.runTurn("continue", () => undefined)).resolves.toEqual({
        text: "continued",
        cancelled: false,
      });
    } finally {
      await rpc.close();
      vi.useRealTimers();
    }
  });

  it("faults a known malformed Tool lifecycle instead of leaving the Turn pending", async () => {
    const onFault = vi.fn();
    const rpc = session("malformed-tool", onFault);
    await rpc.start();

    await expect(rpc.runTurn("synthetic", () => undefined)).rejects.toThrow("invalid Tool update");
    expect(onFault).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "protocolError",
        message: "Pi RPC returned an invalid Tool update",
      }),
    );
    await rpc.close();
  });
});
