import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { harnessThinkingOptionIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import {
  PiRpcSession,
  piRpcProcessCommand,
  type PiRpcProcessAdapter,
  type PiRpcProcessOptions,
  type PiTurnEvent,
} from "../src/pi-rpc-session.js";

type Scenario =
  | "final-only"
  | "reasoning"
  | "reasoning-multiple-blocks"
  | "settled-streaming"
  | "assistant-error"
  | "retry-success"
  | "empty"
  | "tools"
  | "long-running"
  | "cancel"
  | "cancel-no-settle"
  | "malformed-tool"
  | "interaction"
  | "interaction-timeout"
  | "interaction-cancel"
  | "malformed-interaction"
  | "malformed-catalog"
  | "malformed-thinking"
  | "unsupported-thinking"
  | "stats-full"
  | "stats-context-only"
  | "stats-malformed"
  | "stats-unsupported"
  | "stats-unsupported-mismatch"
  | "stats-error"
  | "stats-timeout"
  | "missing-session-id";

class FakePiRpcProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 42_000;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
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

  constructor(scenario: Scenario) {
    super();
    this.#scenario = scenario;
    this.stdin.on("data", (chunk: Buffer) => this.#push(chunk));
    this.stdin.once("finish", () => {
      this.exitCode = 0;
      this.stdout.end();
      this.stderr.end();
      this.emit("exit", 0, null);
    });
    queueMicrotask(() => this.emit("spawn"));
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
        },
        thinkingLevel: this.#thinkingLevel,
        isStreaming: this.#isStreaming,
        contextUsage: { tokens: 45, contextWindow: 200 },
      });
      return;
    }
    if (command.type === "get_session_stats") {
      if (this.#scenario === "stats-timeout") return;
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
      this.#respond(command, {
        entries: [
          {
            id: "user-1",
            parentId: null,
            type: "message",
            message: { role: "user", content: [{ type: "text", text: "hello" }] },
          },
        ],
        leafId: "user-1",
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
          { type: "text", text: "reasoned answer" },
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
      this.#scenario === "settled-streaming" ||
      ((this.#scenario === "cancel" || this.#scenario === "long-running") && this.#promptCount > 1)
    ) {
      const text =
        this.#scenario === "cancel" || this.#scenario === "long-running"
          ? "continued"
          : "synthetic final text";
      const message = { role: "assistant", content: [{ type: "text", text }] };
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
    if (this.#scenario === "cancel" || this.#scenario === "cancel-no-settle") {
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
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }
}

function session(
  scenario: Scenario,
  onFault = vi.fn(),
  options: { commandTimeoutMs?: number; cancelTimeoutMs?: number } = {},
): PiRpcSession {
  const processAdapter: PiRpcProcessAdapter = {
    spawn() {
      return new FakePiRpcProcess(scenario) as unknown as ChildProcessWithoutNullStreams;
    },
  };
  return new PiRpcSession(
    {
      cwd: process.cwd(),
      commandTimeoutMs: options.commandTimeoutMs ?? 2_000,
      cancelTimeoutMs: options.cancelTimeoutMs ?? 500,
      closeTimeoutMs: 500,
      onFault,
    },
    processAdapter,
  );
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for fake Pi event");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("Pi RPC Turn aggregation", () => {
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
        isFile: (candidate) => candidate === piCommand,
      },
    );

    expect(invocation.command).toBe(String.raw`C:\Windows\System32\cmd.exe`);
    expect(invocation.arguments.slice(0, 4)).toEqual(["/d", "/v:off", "/s", "/c"]);
    expect(invocation.arguments.at(-1)).toContain(`"${piCommand}" "--mode" "rpc"`);
    expect(invocation.windowsVerbatimArguments).toBe(true);
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
    ]);
    await rpc.close();
  });

  it("uses streamed Assistant content without replaying the complete message", async () => {
    const rpc = session("reasoning");
    const events: PiTurnEvent[] = [];
    await rpc.start();

    await expect(rpc.runTurn("synthetic", (event) => events.push(event))).resolves.toEqual({
      text: "streamed answer",
      cancelled: false,
    });
    expect(events).toEqual([
      { type: "reasoning.delta", messageId: expect.any(String), delta: "streamed reasoning" },
      { type: "text.delta", messageId: expect.any(String), delta: "streamed answer" },
      { type: "reasoning.completed", messageId: expect.any(String) },
    ]);
    expect(
      new Set(events.flatMap((event) => ("messageId" in event ? [event.messageId] : []))).size,
    ).toBe(1);
    expect(JSON.stringify(events)).not.toContain("suffix");
    expect(JSON.stringify(events)).not.toContain("reasoned answer");
    expect(JSON.stringify(events)).not.toContain("ignored");
    await rpc.close();
  });

  it("does not compare streamed and complete content across thinking blocks", async () => {
    const rpc = session("reasoning-multiple-blocks");
    const events: PiTurnEvent[] = [];
    await rpc.start();

    await expect(rpc.runTurn("synthetic", (event) => events.push(event))).resolves.toEqual({
      text: "reasoned answer",
      cancelled: false,
    });
    expect(
      events.filter((event) => event.type === "reasoning.delta").map(({ delta }) => delta),
    ).toEqual(["first block", "\n\n", "second block", "\n\n", "third block", "\n\n"]);
    expect(events.some(({ type }) => type === "reasoning.completed")).toBe(true);
    await rpc.close();
  });

  it("faults when agent_settled does not agree with the native Streaming state", async () => {
    const onFault = vi.fn();
    const rpc = session("settled-streaming", onFault);
    await rpc.start();

    await expect(rpc.runTurn("synthetic", () => undefined)).rejects.toThrow(
      "agent_settled state is still Streaming",
    );
    expect(onFault).toHaveBeenCalledWith(expect.objectContaining({ kind: "protocolError" }));
    await rpc.close();
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
      { type: "text.delta", messageId: expect.any(String), delta: "recovered" },
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
      "tool.started",
      "tool.started",
      "tool.updated",
      "tool.updated",
      "tool.updated",
      "tool.completed",
      "tool.completed",
      "text.delta",
    ]);
    const textEvents = events.filter((event) => event.type === "text.delta");
    expect(textEvents).toEqual([
      { type: "text.delta", messageId: "before-tools", delta: "before tools" },
      { type: "text.delta", messageId: "after-tools", delta: "tools complete" },
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
    expect(rpc.state).toMatchObject({ provider: "other/provider", modelId: "family/model" });
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
