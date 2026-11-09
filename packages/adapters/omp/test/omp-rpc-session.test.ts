import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  OmpRpcSession,
  ompRpcProcessCommand,
  type OmpRpcProcessAdapter,
  type OmpTurnEvent,
} from "../src/omp-rpc-session.js";
import { OmpSubagentLifecycle } from "../src/omp-subagent-lifecycle.js";
import type { HostEvent } from "@codexhost/harness-adapter";
import { hostItemIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";

class FakeOmpProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 45_001;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly commands: Record<string, unknown>[] = [];
  handleCommand: ((command: Record<string, unknown>) => boolean) | null = null;
  promptHandler: ((command: Record<string, unknown>) => void) | null = null;
  abortHandler: ((command: Record<string, unknown>) => void) | null = null;
  messages: unknown[] = [];
  #buffer = "";
  #sessionId = "omp-session";

  constructor(
    readonly compactMode: "complete" | "stalled" = "complete",
    readonly sessionFile?: string,
    readonly terminalMessageMode: "none" | "replay" | "fallback" | "approval" = "none",
    readonly toolFrameMode:
      "none" | "async-job" | "frame-gaps" | "unknown-update" | "malformed-update" = "none",
    readonly onPrompt?: (process: FakeOmpProcess) => void,
    readonly interactionOverrides: Record<string, unknown> = {},
    readonly subagentSubscriptionMode: "gated" | "unsupported" = "gated",
  ) {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      this.#buffer += chunk.toString("utf8");
      let newline = this.#buffer.indexOf("\n");
      while (newline >= 0) {
        const frame = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        if (frame.length > 0) this.#handle(JSON.parse(frame) as Record<string, unknown>);
        newline = this.#buffer.indexOf("\n");
      }
    });
    this.stdin.once("finish", () => {
      this.exitCode = 0;
      this.stdout.end();
      this.stderr.end();
      this.emit("exit", 0, null);
    });
    queueMicrotask(() => {
      this.#output({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2] });
      this.emit("spawn");
    });
  }

  #output(value: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }

  // Mirrors the real RPC server: subagent frames stay silent until the client
  // subscribes, so the mock cannot hand out frames the server would never send.
  #subagentSubscription: "off" | "progress" | "events" = "off";

  #subagentFramesSubscribed(): boolean {
    return this.#subagentSubscription !== "off";
  }

  sendFrame(value: Record<string, unknown>): void {
    this.#output(value);
  }

  #response(command: Record<string, unknown>, data: Record<string, unknown> = {}): void {
    this.#output({ id: command.id, type: "response", command: command.type, success: true, data });
  }

  #state(): Record<string, unknown> {
    return {
      model: {
        provider: "synthetic",
        id: "omp-model",
        reasoning: true,
        thinking: { efforts: ["low", "high"] },
      },
      thinkingLevel: "high",
      isStreaming: false,
      contextUsage: { tokens: 4, contextWindow: 100 },
      sessionId: this.#sessionId,
      ...(this.sessionFile ? { sessionFile: this.sessionFile } : {}),
    };
  }

  #toolFrames(mode: "async-job" | "frame-gaps" | "unknown-update" | "malformed-update"): void {
    if (mode === "malformed-update") {
      // A frame with no call id stays a protocol fault, not a tolerated frame.
      this.#output({ type: "tool_execution_update", partialResult: { progress: 1 } });
      return;
    }
    if (mode === "async-job") {
      // Mirrors OMP's contract for background jobs: the end that reports a
      // still-running job is followed by updates and a second terminal end.
      this.#output({
        type: "tool_execution_start",
        toolCallId: "async-tool",
        toolName: "task",
        args: { i: "spawn scouts" },
      });
      this.#output({
        type: "tool_execution_end",
        toolCallId: "async-tool",
        toolName: "task",
        result: { async: { state: "running" } },
        isError: false,
      });
      this.#output({
        type: "tool_execution_update",
        toolCallId: "async-tool",
        partialResult: { async: { state: "completed" } },
      });
      this.#output({
        type: "tool_execution_end",
        toolCallId: "async-tool",
        toolName: "task",
        result: { async: { state: "completed" } },
        isError: false,
      });
      return;
    }
    if (mode === "frame-gaps") {
      // Missing `partialResult` and missing `isError` are tolerated.
      this.#output({
        type: "tool_execution_start",
        toolCallId: "gap-tool",
        toolName: "bash",
        args: {},
      });
      this.#output({ type: "tool_execution_update", toolCallId: "gap-tool" });
      this.#output({
        type: "tool_execution_end",
        toolCallId: "gap-tool",
        toolName: "bash",
        result: { content: [{ type: "text", text: "done" }] },
      });
      return;
    }
    // A call this Turn never started must not kill the Turn.
    this.#output({
      type: "tool_execution_update",
      toolCallId: "never-started",
      partialResult: { progress: 1 },
    });
  }

  #handle(command: Record<string, unknown>): void {
    this.commands.push(command);
    if (this.handleCommand?.(command)) return;
    if (command.type === "abort" && this.abortHandler) return this.abortHandler(command);
    if (command.type === "extension_ui_response") {
      if (this.terminalMessageMode === "approval") {
        const message = {
          role: "assistant",
          responseId: "assistant-1",
          content: [{ type: "text", text: "PONG" }],
        };
        this.#output({ type: "message_start", message });
        this.#output({
          type: "message_update",
          message,
          assistantMessageEvent: { type: "text_delta", delta: "PONG" },
        });
        this.#output({ type: "message_end", message: { ...message, stopReason: "stop" } });
        this.#output({ type: "agent_end", isTerminal: true });
      }
      return;
    }
    if (command.type === "set_subagent_subscription") {
      if (this.subagentSubscriptionMode === "unsupported") {
        this.#output({
          id: command.id,
          type: "response",
          command: command.type,
          success: false,
          error: `Unknown command: ${command.type}`,
        });
        return;
      }
      const level = command.level;
      if (level === "off" || level === "progress" || level === "events") {
        this.#subagentSubscription = level;
      }
      return this.#response(command, { level: this.#subagentSubscription });
    }
    if (command.type === "negotiate_protocol")
      return this.#response(command, { protocolVersion: 2 });
    if (command.type === "get_state") return this.#response(command, this.#state());
    if (command.type === "get_messages")
      return this.#response(command, { messages: this.messages });
    if (command.type === "get_subagent_messages") {
      return this.#response(command, {
        sessionFile: "/tmp/subagent.jsonl",
        fromByte: command.fromByte ?? 0,
        nextByte: 42,
        reset: false,
        entries: [],
        messages: [],
      });
    }
    if (command.type === "branch") {
      this.#sessionId = "omp-forked-session";
      return this.#response(command, { text: "", cancelled: false });
    }
    if (command.type === "compact") {
      this.#output({ type: "compaction_start", reason: "manual" });
      if (this.compactMode === "stalled") return;
      queueMicrotask(() => {
        this.#output({
          type: "compaction_end",
          reason: "manual",
          result: {
            summary: "Synthetic manual summary",
            firstKeptEntryId: "user-1",
            tokensBefore: 100,
            estimatedTokensAfter: 20,
          },
          aborted: false,
        });
        this.#response(command, {
          summary: "Synthetic manual summary",
          firstKeptEntryId: "user-1",
          tokensBefore: 100,
          estimatedTokensAfter: 20,
        });
      });
      return;
    }
    if (command.type === "prompt") {
      if (this.promptHandler) return this.promptHandler(command);
      this.#response(command);
      queueMicrotask(() => {
        if (this.toolFrameMode !== "none") this.#toolFrames(this.toolFrameMode);
        this.onPrompt?.(this);
        if (this.terminalMessageMode === "approval") {
          this.#output({
            type: "extension_ui_request",
            id: "approval-1",
            method: "select",
            title: "Approve write?",
            options: ["Approve", "Deny"],
            ...this.interactionOverrides,
          });
          return;
        }
        if (this.#subagentFramesSubscribed()) {
          this.#output({
            type: "subagent_lifecycle",
            payload: {
              id: "subagent-1",
              index: 0,
              agent: "task",
              agentSource: "bundled",
              status: "started",
              description: "Inspect the repository",
              sessionFile: "/tmp/subagent.jsonl",
              parentToolCallId: "tool-1",
            },
          });
          this.#output({
            type: "subagent_progress",
            payload: {
              index: 0,
              agent: "task",
              agentSource: "bundled",
              task: "Inspect the repository",
              progress: { id: "subagent-1", status: "running", recentOutput: [] },
              parentToolCallId: "tool-1",
              sessionFile: "/tmp/subagent.jsonl",
            },
          });
        }
        const message = {
          role: "assistant",
          responseId: "assistant-1",
          content: [{ type: "text", text: "PONG" }],
        };
        this.#output({ type: "message_start", message });
        if (this.terminalMessageMode !== "fallback") {
          this.#output({
            type: "message_update",
            message,
            assistantMessageEvent: { type: "text_delta", delta: "PONG" },
          });
          this.#output({ type: "message_end", message: { ...message, stopReason: "stop" } });
        }
        if (this.#subagentFramesSubscribed()) {
          this.#output({
            type: "subagent_lifecycle",
            payload: {
              id: "subagent-1",
              index: 0,
              agent: "task",
              agentSource: "bundled",
              status: "completed",
              parentToolCallId: "tool-1",
            },
          });
        }
        this.#output({
          type: "agent_end",
          isTerminal: true,
          ...(this.terminalMessageMode !== "none"
            ? {
                messages: [
                  {
                    role: "assistant",
                    responseId: "assistant-before-final",
                    content: [{ type: "text", text: "Earlier tool setup" }],
                    stopReason: "toolUse",
                  },
                  { ...message, stopReason: "stop" },
                ],
              }
            : {}),
        });
      });
      return;
    }
    this.#response(command);
  }
}

describe("OMP RPC session", () => {
  it.each(["background wake", "silent drain", "settled during state check"])(
    "keeps cancellation active through %s and permits the next Turn",
    async (scenario) => {
      vi.useFakeTimers();
      const process = new FakeOmpProcess();
      const onFault = vi.fn();
      let cancelling = false;
      let streaming = false;
      let background = true;
      let aborts = 0;
      let stateChecks = 0;
      let pendingChecks = 0;
      let maxPendingChecks = 0;
      process.handleCommand = (command) => {
        if (command.type === "prompt" && !cancelling) {
          process.sendFrame({ type: "response", id: command.id, command: "prompt", success: true });
          return true;
        }
        if (command.type === "abort") {
          cancelling = true;
          aborts++;
          streaming = false;
          process.sendFrame({ type: "agent_end", isTerminal: true });
          process.sendFrame({ type: "response", id: command.id, command: "abort", success: true });
          return true;
        }
        if (command.type !== "get_state" || !cancelling) return false;
        stateChecks++;
        pendingChecks++;
        maxPendingChecks = Math.max(maxPendingChecks, pendingChecks);
        const data = {
          sessionId: "omp-session",
          isStreaming: streaming,
          isSettled: !streaming && !background,
          hasPendingAsyncWork: background,
          queuedMessageCount: 0,
        };
        const respond = () => {
          pendingChecks--;
          process.sendFrame({
            type: "response",
            id: command.id,
            command: "get_state",
            success: true,
            data,
          });
        };
        if (scenario === "settled during state check" && stateChecks === 1) {
          setTimeout(() => {
            background = false;
            process.sendFrame({ type: "session_settled" });
          }, 100);
          setTimeout(respond, 300);
        } else respond();
        return true;
      };
      const session = new OmpRpcSession(
        { cwd: "/synthetic", cancelTimeoutMs: 1_000, onFault },
        { spawn: () => process as never },
      );
      try {
        await session.start();
        const outcome = session
          .runTurn("cancel with pending job", () => undefined)
          .then(
            (value) => ({ value }),
            (error: Error) => ({ error: error.message }),
          );
        const aborting = session.abort();
        if (scenario !== "settled during state check") {
          setTimeout(() => {
            background = false;
            if (scenario === "background wake") {
              streaming = true;
              process.sendFrame({ type: "agent_start" });
            }
          }, 300);
        }
        await vi.advanceTimersByTimeAsync(1_001);
        await aborting;
        await expect(outcome).resolves.toEqual({
          value: { text: "", cancelled: true, agentInvoked: true },
        });
        expect(aborts).toBe(scenario === "background wake" ? 2 : 1);
        expect(maxPendingChecks).toBe(1);
        expect(onFault).not.toHaveBeenCalled();
        process.handleCommand = null;
        await expect(session.runTurn("continue", () => undefined)).resolves.toMatchObject({
          text: "PONG",
          cancelled: false,
        });
        // A cancelled Turn's delayed check must not query or abort its successor.
        const commands = process.commands.length;
        await vi.advanceTimersByTimeAsync(1_000);
        expect(process.commands).toHaveLength(commands);
      } finally {
        await session.close();
        vi.useRealTimers();
      }
    },
  );

  it("waits through slow native cancellation and accepts another Turn afterwards", async () => {
    vi.useFakeTimers();
    const process = new FakeOmpProcess();
    const onFault = vi.fn();
    let cancelling = false;
    process.handleCommand = (command) => {
      if (command.type === "prompt" && !cancelling) {
        process.sendFrame({ type: "response", id: command.id, command: "prompt", success: true });
        return true;
      }
      if (command.type !== "abort") return false;
      cancelling = true;
      setTimeout(() => {
        process.sendFrame({ type: "agent_end", isTerminal: true });
        process.sendFrame({ type: "response", id: command.id, command: "abort", success: true });
      }, 3_000);
      return true;
    };
    const session = new OmpRpcSession(
      { cwd: "/synthetic", onFault },
      {
        spawn: () => process as never,
      },
    );
    try {
      await session.start();
      const turn = session.runTurn("cancel slowly", () => undefined);
      const outcome = turn.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      const aborting = session.abort();
      const abortOutcome = aborting.catch((error) => error);
      expect(session.abort()).toBe(aborting);
      await vi.advanceTimersByTimeAsync(2_500);
      expect(onFault).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(500);
      await expect(abortOutcome).resolves.toBeUndefined();
      await expect(outcome).resolves.toEqual({
        value: { text: "", cancelled: true, agentInvoked: true },
      });
      expect(process.commands.filter((command) => command.type === "abort")).toHaveLength(1);
      await expect(session.runTurn("continue", () => undefined)).resolves.toEqual({
        text: "PONG",
        cancelled: false,
        agentInvoked: true,
      });
    } finally {
      await session.close();
      vi.useRealTimers();
    }
  });

  it.each([
    "restored",
    "configuration restored",
    "configuration rejected",
    "reset refused",
    "resume refused",
    "identity changed",
    "background survives",
    "queued messages",
    "compaction",
  ])(
    "cancels persisted background work through native lifecycle recovery: %s",
    async (scenario) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "omp-cancel-recovery-"));
      const sessionFile = path.join(directory, "session.jsonl");
      await writeFile(
        sessionFile,
        JSON.stringify({ type: "session", id: "omp-session", cwd: directory }) + "\n",
      );
      const process = new FakeOmpProcess("complete", sessionFile);
      const onFault = vi.fn();
      let cancelling = false;
      let resumed = false;
      let modelRestored = false;
      let thinkingRestored = false;
      let nextTurn = false;
      process.handleCommand = (command) => {
        const respond = (data: Record<string, unknown> = {}) =>
          process.sendFrame({
            type: "response",
            id: command.id,
            command: command.type,
            success: true,
            data,
          });
        if (command.type === "prompt" && !nextTurn) {
          respond();
          process.sendFrame({ type: "agent_end", isTerminal: false, yielded: true });
          return true;
        }
        if (command.type === "abort") {
          cancelling = true;
          respond();
          return true;
        }
        if (command.type === "new_session") {
          respond({ cancelled: scenario === "reset refused" });
          return true;
        }
        if (command.type === "switch_session") {
          expect(command.sessionPath).toBe(sessionFile);
          resumed = true;
          respond({ cancelled: scenario === "resume refused" });
          return true;
        }
        if (command.type === "set_model") {
          expect(command.provider).toBe("synthetic");
          expect(command.modelId).toBe("omp-model");
          modelRestored = scenario !== "configuration rejected";
          respond();
          return true;
        }
        if (command.type === "set_thinking_level") {
          expect(command.level).toBe("high");
          thinkingRestored = true;
          respond();
          return true;
        }
        if (command.type === "get_state" && cancelling) {
          const changedConfiguration = resumed && scenario.startsWith("configuration");
          respond({
            sessionId:
              resumed && scenario === "identity changed" ? "another-session" : "omp-session",
            sessionFile,
            model: {
              provider: "synthetic",
              id: changedConfiguration && !modelRestored ? "other-model" : "omp-model",
              reasoning: true,
            },
            thinkingLevel: changedConfiguration && !thinkingRestored ? "low" : "high",
            isStreaming: false,
            isSettled: resumed && scenario !== "background survives",
            hasPendingAsyncWork: !resumed || scenario === "background survives",
            queuedMessageCount: scenario === "queued messages" ? 1 : 0,
            isCompacting: scenario === "compaction",
          });
          return true;
        }
        return false;
      };
      const session = new OmpRpcSession(
        { cwd: directory, cancelTimeoutMs: 100, onFault },
        { spawn: () => process as never },
      );
      try {
        await session.start();
        const outcome = session
          .runTurn("wait for owned background work", () => undefined)
          .catch((error) => error);
        await session.abort();
        if (scenario === "restored" || scenario === "configuration restored") {
          await expect(outcome).resolves.toEqual({ text: "", cancelled: true, agentInvoked: true });
          expect(onFault).not.toHaveBeenCalled();
          expect(session.state).toMatchObject({
            sessionId: "omp-session",
            sessionFile,
            modelId: "omp-model",
            thinkingLevel: "high",
          });
          nextTurn = true;
          cancelling = false;
          await expect(session.runTurn("continue", () => undefined)).resolves.toMatchObject({
            text: "PONG",
            cancelled: false,
          });
        } else {
          await expect(outcome).resolves.toBeInstanceOf(Error);
          expect(onFault).toHaveBeenCalledTimes(1);
        }
        expect(process.commands.filter((command) => command.type === "new_session")).toHaveLength(
          scenario === "queued messages" || scenario === "compaction" ? 0 : 1,
        );
        expect(
          process.commands.filter((command) => command.type === "switch_session"),
        ).toHaveLength(
          ["reset refused", "queued messages", "compaction"].includes(scenario) ? 0 : 1,
        );
      } finally {
        await session.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("completes a local prompt without agent_end and releases the next turn", async () => {
    const process = new FakeOmpProcess();
    process.promptHandler = (command) => {
      process.sendFrame({ type: "command_output", text: "Context window: 100 tokens" });
      process.sendFrame({
        type: "response",
        id: command.id,
        command: "prompt",
        success: true,
        data: { agentInvoked: false },
      });
    };
    const session = new OmpRpcSession(
      { cwd: "/synthetic", commandTimeoutMs: 2_000 },
      { spawn: () => process as never },
    );
    const events: OmpTurnEvent[] = [];
    try {
      await session.start();
      let result: unknown;
      const turn = session.runTurn("/context", (event) => events.push(event));
      void turn.then(
        (value) => {
          result = value;
        },
        () => undefined,
      );
      await vi.waitFor(
        () =>
          expect(result).toEqual({
            text: "Context window: 100 tokens",
            cancelled: false,
            agentInvoked: false,
          }),
        { timeout: 200 },
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "text.delta",
          delta: "Context window: 100 tokens",
        }),
      );
      process.promptHandler = null;
      await expect(session.runTurn("ping", () => undefined)).resolves.toEqual({
        text: "PONG",
        cancelled: false,
        agentInvoked: true,
      });
    } finally {
      await session.close();
    }
  });

  it.each(["completed", "aborted", "error"])(
    "settles asynchronous local %s results after admission",
    async (status) => {
      const process = new FakeOmpProcess();
      process.promptHandler = (command) => {
        process.sendFrame({ type: "response", id: command.id, command: "prompt", success: true });
        queueMicrotask(() => {
          if (status === "error") {
            process.sendFrame({
              type: "response",
              id: command.id,
              command: "prompt",
              success: false,
              error: "Command failed",
            });
          }
          process.sendFrame({
            type: "prompt_result",
            id: command.id,
            agentInvoked: false,
            status,
            ...(status === "error"
              ? { error: { message: "Command failed", retryable: false } }
              : {}),
          });
        });
      };
      const session = new OmpRpcSession({ cwd: "/synthetic" }, { spawn: () => process as never });
      try {
        await session.start();
        await expect(session.runTurn("/extension-command", () => undefined)).resolves.toEqual({
          text: "",
          cancelled: status === "aborted",
          agentInvoked: false,
          ...(status === "error" ? { error: "Command failed" } : {}),
        });
        process.promptHandler = null;
        await expect(session.runTurn("continue", () => undefined)).resolves.toMatchObject({
          agentInvoked: true,
          text: "PONG",
        });
      } finally {
        await session.close();
      }
    },
  );

  it.each([false, true])(
    "confirms idle cancellation without a new agent_end: background=%s",
    async (background) => {
      const process = new FakeOmpProcess();
      const onFault = vi.fn();
      let cancelling = false;
      process.handleCommand = (command) => {
        if (command.type === "prompt" && !cancelling) {
          process.sendFrame({ type: "response", id: command.id, command: "prompt", success: true });
          if (background)
            process.sendFrame({ type: "agent_end", isTerminal: false, yielded: true });
          return true;
        }
        if (command.type === "abort") {
          cancelling = true;
          process.sendFrame({ type: "response", id: command.id, command: "abort", success: true });
          return true;
        }
        if (command.type === "get_state" && cancelling) {
          process.sendFrame({
            type: "response",
            id: command.id,
            command: "get_state",
            success: true,
            data: {
              sessionId: "omp-session",
              isStreaming: false,
              isSettled: true,
              isCompacting: false,
              queuedMessageCount: 0,
              hasPendingAsyncWork: false,
            },
          });
          return true;
        }
        return false;
      };
      const session = new OmpRpcSession(
        { cwd: "/synthetic", cancelTimeoutMs: 50, onFault },
        {
          spawn: () => process as never,
        },
      );
      try {
        await session.start();
        const outcome = session
          .runTurn("idle cancellation", () => undefined)
          .then(
            (value) => ({ value }),
            (error) => ({ error }),
          );
        await session.abort();
        await expect(outcome).resolves.toEqual({
          value: { text: "", cancelled: true, agentInvoked: true },
        });
        expect(onFault).not.toHaveBeenCalled();
        await expect(session.runTurn("retry", () => undefined)).resolves.toMatchObject({
          cancelled: false,
        });
      } finally {
        await session.close();
      }
    },
  );

  it.each(["none", "before", "after"])(
    "waits for background work to drain: terminal agent_end=%s",
    async (terminal) => {
      const process = new FakeOmpProcess();
      const onFault = vi.fn();
      let cancelling = false;
      let settled = false;
      process.handleCommand = (command) => {
        if (command.type === "prompt") {
          process.sendFrame({ type: "response", id: command.id, command: "prompt", success: true });
          process.sendFrame({ type: "agent_end", isTerminal: false, yielded: true });
          return true;
        }
        if (command.type === "abort") {
          cancelling = true;
          if (terminal === "before") process.sendFrame({ type: "agent_end", isTerminal: true });
          process.sendFrame({ type: "response", id: command.id, command: "abort", success: true });
          return true;
        }
        if (command.type === "get_state" && cancelling) {
          process.sendFrame({
            type: "response",
            id: command.id,
            command: "get_state",
            success: true,
            data: {
              sessionId: "omp-session",
              isStreaming: false,
              isSettled: settled,
              hasPendingAsyncWork: !settled,
              queuedMessageCount: 0,
            },
          });
          return true;
        }
        return false;
      };
      const session = new OmpRpcSession(
        { cwd: "/synthetic", onFault },
        { spawn: () => process as never },
      );
      try {
        await session.start();
        const turn = session.runTurn("wait for jobs", () => undefined);
        let completed = false;
        void turn.then(() => {
          completed = true;
        });
        await session.abort();
        if (terminal === "after") process.sendFrame({ type: "agent_end", isTerminal: true });
        expect(completed).toBe(false);
        process.sendFrame({ type: "session_settled" });
        await Promise.resolve();
        expect(completed).toBe(false);
        settled = true;
        process.sendFrame({ type: "session_settled" });
        await expect(turn).resolves.toEqual({ text: "", cancelled: true, agentInvoked: true });
        expect(onFault).not.toHaveBeenCalled();
      } finally {
        await session.close();
      }
    },
  );

  it("accepts synchronous empty local output without relaxing ordinary empty-output checks", async () => {
    const process = new FakeOmpProcess();
    process.promptHandler = (command) =>
      process.sendFrame({
        type: "response",
        id: command.id,
        command: "prompt",
        success: true,
        data: { agentInvoked: false },
      });
    const session = new OmpRpcSession({ cwd: "/synthetic" }, { spawn: () => process as never });
    try {
      await session.start();
      await expect(session.runTurn("/local", () => undefined)).resolves.toEqual({
        text: "",
        cancelled: false,
        agentInvoked: false,
      });
      process.promptHandler = (command) => {
        process.sendFrame({ type: "response", id: command.id, command: "prompt", success: true });
        process.sendFrame({ type: "agent_end", isTerminal: true });
      };
      await expect(session.runTurn("continue", () => undefined)).rejects.toThrow(
        "settled without displayable output",
      );
    } finally {
      await session.close();
    }
  });

  it("ignores mismatched, stale, and agent-invoked prompt results", async () => {
    const process = new FakeOmpProcess();
    const promptIds: unknown[] = [];
    process.promptHandler = (command) => {
      promptIds.push(command.id);
      process.sendFrame({ type: "response", id: command.id, command: "prompt", success: true });
    };
    const session = new OmpRpcSession({ cwd: "/synthetic" }, { spawn: () => process as never });
    try {
      await session.start();
      const first = session.runTurn("/local", () => undefined);
      process.sendFrame({
        type: "prompt_result",
        id: promptIds[0],
        agentInvoked: false,
        status: "completed",
      });
      await first;
      let settled = false;
      const second = session.runTurn("normal prompt", () => undefined);
      void second.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      for (const frame of [
        { id: promptIds[0], agentInvoked: false },
        { id: "unrelated", agentInvoked: false },
        { agentInvoked: false },
        { id: promptIds[1], agentInvoked: true },
        { id: promptIds[1] },
      ])
        process.sendFrame({ type: "prompt_result", status: "completed", ...frame });
      await session.getEntries();
      expect(settled).toBe(false);
      process.sendFrame({ type: "agent_end", isTerminal: false });
      await session.getEntries();
      expect(settled).toBe(false);
      process.sendFrame({
        type: "message_end",
        message: {
          role: "assistant",
          responseId: "normal",
          content: [{ type: "text", text: "normal result" }],
          stopReason: "stop",
        },
      });
      process.sendFrame({ type: "agent_end", isTerminal: true });
      await expect(second).resolves.toEqual({
        text: "normal result",
        cancelled: false,
        agentInvoked: true,
      });
    } finally {
      await session.close();
    }
  });

  it.each(["before-ack", "after-ack"])(
    "cancels active model turns only after terminal completion %s",
    async (ordering) => {
      const process = new FakeOmpProcess();
      process.promptHandler = (command) =>
        process.sendFrame({ type: "response", id: command.id, command: "prompt", success: true });
      let abortId: unknown;
      process.abortHandler = (command) => {
        abortId = command.id;
      };
      const session = new OmpRpcSession({ cwd: "/synthetic" }, { spawn: () => process as never });
      try {
        await session.start();
        let settled = false;
        const turn = session.runTurn("active model prompt", () => undefined);
        void turn.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        const abort = session.abort();
        if (ordering === "before-ack") process.sendFrame({ type: "agent_end", isTerminal: true });
        await session.getEntries();
        expect(settled).toBe(false);
        process.sendFrame({ type: "response", id: abortId, command: "abort", success: true });
        await abort;
        if (ordering === "after-ack") {
          expect(settled).toBe(false);
          process.sendFrame({ type: "agent_end", isTerminal: true });
        }
        await expect(turn).resolves.toEqual({ text: "", cancelled: true, agentInvoked: true });
      } finally {
        await session.close();
      }
    },
  );

  it.each([
    { label: "missing settlement status", data: {} },
    { label: "a streaming agent", data: { isSettled: true, isStreaming: true } },
    { label: "background work", data: { isSettled: true, hasPendingAsyncWork: true } },
    { label: "queued messages", data: { isSettled: true, queuedMessageCount: 1 } },
    { label: "compaction", data: { isSettled: true, isCompacting: true } },
  ])("retains bounded failure for cancellation with $label", async ({ data }) => {
    const process = new FakeOmpProcess();
    const onFault = vi.fn();
    let cancelling = false;
    process.handleCommand = (command) => {
      if (command.type === "prompt" || command.type === "abort") {
        cancelling ||= command.type === "abort";
        process.sendFrame({
          type: "response",
          id: command.id,
          command: command.type,
          success: true,
        });
        return true;
      }
      if (command.type === "get_state" && cancelling) {
        process.sendFrame({
          type: "response",
          id: command.id,
          command: "get_state",
          success: true,
          data: { sessionId: "omp-session", isStreaming: false, ...data },
        });
        return true;
      }
      return false;
    };
    const session = new OmpRpcSession(
      { cwd: "/synthetic", cancelTimeoutMs: 20, onFault },
      {
        spawn: () => process as never,
      },
    );
    try {
      await session.start();
      const outcome = session
        .runTurn("stalled cancellation", () => undefined)
        .catch((error) => error);
      await session.abort();
      expect(onFault).not.toHaveBeenCalled();
      process.sendFrame({ type: "session_settled" });
      await expect(outcome).resolves.toMatchObject({
        message: "Omp Turn cancellation did not settle within its bound",
      });
      expect(onFault).toHaveBeenCalledTimes(1);
      await session.close();
      expect(process.exitCode).toBe(0);
    } finally {
      await session.close();
    }
  });

  it("keeps the bounded failure when an active model abort is acknowledged without a terminal event", async () => {
    const process = new FakeOmpProcess();
    process.promptHandler = (command) =>
      process.sendFrame({ type: "response", id: command.id, command: "prompt", success: true });
    const onFault = vi.fn();
    const session = new OmpRpcSession(
      { cwd: "/synthetic", cancelTimeoutMs: 30, onFault },
      { spawn: () => process as never },
    );
    try {
      await session.start();
      const turn = session.runTurn("active model prompt", () => undefined);
      const rejected = expect(turn).rejects.toThrow(
        "Omp Turn cancellation did not settle within its bound",
      );
      await session.abort();
      await rejected;
      expect(onFault).toHaveBeenCalledWith(expect.objectContaining({ kind: "protocolError" }));
    } finally {
      await session.close();
    }
  });

  it("keeps legacy agent_end cancellation when get_state omits isSettled", async () => {
    const process = new FakeOmpProcess();
    process.handleCommand = (command) => {
      if (command.type !== "prompt") return false;
      process.sendFrame({ type: "response", id: command.id, command: "prompt", success: true });
      return true;
    };
    const session = new OmpRpcSession({ cwd: "/synthetic" }, { spawn: () => process as never });
    try {
      await session.start();
      const turn = session.runTurn("legacy cancellation", () => undefined);
      await session.abort();
      process.sendFrame({ type: "agent_end", isTerminal: true });
      await expect(turn).resolves.toEqual({ text: "", cancelled: true, agentInvoked: true });
    } finally {
      await session.close();
    }
  });

  it("makes concurrent close callers wait for the same native process exit", async () => {
    const process = new FakeOmpProcess();
    process.stdin.removeAllListeners("finish");
    const session = new OmpRpcSession({ cwd: "/synthetic" }, { spawn: () => process as never });
    await session.start();
    const first = session.close();
    const second = session.close();
    let closed = false;
    void second.then(() => {
      closed = true;
    });
    try {
      await Promise.resolve();
      expect(closed).toBe(false);
    } finally {
      process.exitCode = 0;
      process.emit("exit", 0, null);
    }
    await Promise.all([first, second]);
    expect(second).toBe(first);
  });

  it("uses OMP's --resume flag for persisted sessions", () => {
    expect(
      ompRpcProcessCommand(
        { cwd: "/synthetic", environment: {}, sessionFile: "/tmp/omp.jsonl" },
        {
          platform: "darwin",
          homeDirectory: "/Users/test",
          isExecutable: () => true,
        },
      ),
    ).toMatchObject({ arguments: ["--mode", "rpc-ui", "--resume", "/tmp/omp.jsonl"] });
  });

  it("maps OMP Permission Modes to startup approval flags", () => {
    const dependencies = {
      platform: "darwin" as const,
      homeDirectory: "/Users/test",
      isExecutable: () => true,
    };
    expect(
      ompRpcProcessCommand(
        { cwd: "/synthetic", environment: {}, permissionMode: "write" },
        dependencies,
      ),
    ).toMatchObject({ arguments: ["--mode", "rpc-ui", "--approval-mode", "write"] });
  });

  it("uses OMP's yolo approval mode for unattended full access", () => {
    expect(
      ompRpcProcessCommand(
        { cwd: "/synthetic", environment: {}, permissionMode: "yolo" },
        {
          platform: "darwin",
          homeDirectory: "/Users/test",
          isExecutable: () => true,
        },
      ),
    ).toMatchObject({ arguments: ["--mode", "rpc-ui", "--approval-mode", "yolo"] });
  });

  it("uses OMP's --fork flag for forked sessions", () => {
    expect(
      ompRpcProcessCommand(
        { cwd: "/synthetic", environment: {}, forkSessionFile: "/tmp/omp.jsonl" },
        {
          platform: "darwin",
          homeDirectory: "/Users/test",
          isExecutable: () => true,
        },
      ),
    ).toMatchObject({ arguments: ["--mode", "rpc-ui", "--fork", "/tmp/omp.jsonl"] });
  });

  it("reports native exit before readiness instead of waiting for the ready timeout", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null,
    });
    const adapter: OmpRpcProcessAdapter = {
      spawn: () => {
        queueMicrotask(() => {
          child.emit("spawn");
          child.stderr.write(
            "No models available. Use /login or set an API key environment variable.",
          );
          child.exitCode = 1;
          child.stdout.end();
          child.stderr.end();
          child.emit("exit", 1, null);
        });
        return child as never;
      },
    };
    const session = new OmpRpcSession({ cwd: "/synthetic", commandTimeoutMs: 2000 }, adapter);
    try {
      await expect(session.start()).rejects.toMatchObject({
        kind: "processExited",
        diagnostic: expect.stringContaining("No models available"),
      });
    } finally {
      await session.close();
    }
  });

  it("starts through ready/negotiation and settles a streamed text turn on agent_end", async () => {
    const process = new FakeOmpProcess();
    const adapter: OmpRpcProcessAdapter = { spawn: () => process as never };
    const session = new OmpRpcSession({ cwd: "/synthetic", commandTimeoutMs: 2_000 }, adapter);
    await session.start();
    const events: OmpTurnEvent[] = [];
    await expect(session.runTurn("hello", (event) => events.push(event))).resolves.toEqual({
      text: "PONG",
      cancelled: false,
      agentInvoked: true,
    });
    expect(events).toContainEqual({ type: "text.delta", messageId: "assistant-1", delta: "PONG" });
    await session.close();
  });

  it("subscribes to subagent frames during startup so native delegations are not silent", async () => {
    const process = new FakeOmpProcess();
    const adapter: OmpRpcProcessAdapter = { spawn: () => process as never };
    const session = new OmpRpcSession({ cwd: "/synthetic", commandTimeoutMs: 2_000 }, adapter);
    await session.start();
    expect(process.commands).toContainEqual(
      expect.objectContaining({ type: "set_subagent_subscription", level: "events" }),
    );
    const events: OmpTurnEvent[] = [];
    await session.runTurn("spawn scouts", (event) => events.push(event));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "subagent.started",
        callId: "subagent-1",
        nativeSubagentId: "subagent-1",
        description: "Inspect the repository",
      }),
    );
    await session.close();
  });

  it("skips the subagent subscription for transports that opt out", async () => {
    const process = new FakeOmpProcess();
    const adapter: OmpRpcProcessAdapter = { spawn: () => process as never };
    const session = new OmpRpcSession(
      { cwd: "/synthetic", commandTimeoutMs: 2_000, subscribeSubagentEvents: false },
      adapter,
    );
    await session.start();
    expect(process.commands).not.toContainEqual(
      expect.objectContaining({ type: "set_subagent_subscription" }),
    );
    await session.close();
  });

  it("still starts and settles turns when the server rejects the subagent subscription", async () => {
    const process = new FakeOmpProcess(
      "complete",
      undefined,
      "none",
      "none",
      undefined,
      {},
      "unsupported",
    );
    const adapter: OmpRpcProcessAdapter = { spawn: () => process as never };
    const session = new OmpRpcSession({ cwd: "/synthetic", commandTimeoutMs: 2_000 }, adapter);
    await expect(session.start()).resolves.toBeDefined();
    const events: OmpTurnEvent[] = [];
    await expect(session.runTurn("hello", (event) => events.push(event))).resolves.toEqual({
      text: "PONG",
      cancelled: false,
      agentInvoked: true,
    });
    expect(events).toContainEqual({ type: "text.delta", messageId: "assistant-1", delta: "PONG" });
    expect(events.some((event) => event.type.startsWith("subagent"))).toBe(false);
    await session.close();
  });

  it("tolerates the late update and repeated end of an async Omp Tool job", async () => {
    const process = new FakeOmpProcess("complete", undefined, "none", "async-job");
    const adapter: OmpRpcProcessAdapter = { spawn: () => process as never };
    const onFault = vi.fn();
    const session = new OmpRpcSession(
      { cwd: "/synthetic", commandTimeoutMs: 2_000, onFault },
      adapter,
    );
    await session.start();
    const events: OmpTurnEvent[] = [];

    await expect(session.runTurn("spawn scouts", (event) => events.push(event))).resolves.toEqual({
      text: "PONG",
      cancelled: false,
      agentInvoked: true,
    });
    expect(onFault).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type.startsWith("tool."))).toEqual([
      {
        type: "tool.started",
        callId: "async-tool",
        toolName: "task",
        arguments: { i: "spawn scouts" },
      },
      {
        type: "tool.completed",
        callId: "async-tool",
        toolName: "task",
        result: { async: { state: "running" } },
        isError: false,
      },
    ]);
    await session.close();
  });

  it("tolerates a missing partialResult and a missing isError on Tool frames", async () => {
    const process = new FakeOmpProcess("complete", undefined, "none", "frame-gaps");
    const adapter: OmpRpcProcessAdapter = { spawn: () => process as never };
    const onFault = vi.fn();
    const session = new OmpRpcSession(
      { cwd: "/synthetic", commandTimeoutMs: 2_000, onFault },
      adapter,
    );
    await session.start();
    const events: OmpTurnEvent[] = [];

    await expect(session.runTurn("run bash", (event) => events.push(event))).resolves.toEqual({
      text: "PONG",
      cancelled: false,
      agentInvoked: true,
    });
    expect(onFault).not.toHaveBeenCalled();
    expect(events).toContainEqual({ type: "tool.updated", callId: "gap-tool", output: null });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool.completed", callId: "gap-tool", isError: false }),
    );
    await session.close();
  });

  it("keeps a Turn alive when an update references a Tool it never started", async () => {
    const process = new FakeOmpProcess("complete", undefined, "none", "unknown-update");
    const adapter: OmpRpcProcessAdapter = { spawn: () => process as never };
    const onFault = vi.fn();
    const session = new OmpRpcSession(
      { cwd: "/synthetic", commandTimeoutMs: 2_000, onFault },
      adapter,
    );
    await session.start();
    const events: OmpTurnEvent[] = [];

    await expect(session.runTurn("hello", (event) => events.push(event))).resolves.toEqual({
      text: "PONG",
      cancelled: false,
      agentInvoked: true,
    });
    expect(onFault).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type.startsWith("tool."))).toEqual([]);
    await session.close();
  });

  it("still faults on a Tool update whose call id is missing", async () => {
    const process = new FakeOmpProcess("complete", undefined, "none", "malformed-update");
    const adapter: OmpRpcProcessAdapter = { spawn: () => process as never };
    const onFault = vi.fn();
    const session = new OmpRpcSession(
      { cwd: "/synthetic", commandTimeoutMs: 2_000, onFault },
      adapter,
    );
    await session.start();

    await expect(session.runTurn("hello", () => undefined)).rejects.toThrow(
      "Omp RPC returned an invalid Tool update",
    );
    expect(onFault).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "protocolError", message: expect.stringContaining("Tool") }),
    );
    await session.close();
  });

  it.each(["idle", "next Turn"])(
    "ignores old Tool frames during %s without affecting the next Tool",
    async (timing) => {
      let turnNumber = 0;
      const lateFrames = (process: FakeOmpProcess): void => {
        process.sendFrame({
          type: "tool_execution_update",
          toolCallId: "old-tool",
          partialResult: { progress: "late" },
        });
        process.sendFrame({
          type: "tool_execution_end",
          toolCallId: "old-tool",
          toolName: "task",
          result: "late result",
        });
      };
      const process = new FakeOmpProcess("complete", undefined, "none", "none", (child) => {
        const callId = ++turnNumber === 1 ? "old-tool" : "new-tool";
        child.sendFrame({
          type: "tool_execution_start",
          toolCallId: callId,
          toolName: "task",
          args: {},
        });
        if (turnNumber === 2 && timing === "next Turn") lateFrames(child);
        child.sendFrame({
          type: "tool_execution_update",
          toolCallId: callId,
          partialResult: "working",
        });
        child.sendFrame({
          type: "tool_execution_end",
          toolCallId: callId,
          toolName: "task",
          result: "done",
        });
      });
      const onFault = vi.fn();
      const session = new OmpRpcSession(
        { cwd: "/synthetic", commandTimeoutMs: 2_000, onFault },
        { spawn: () => process as never },
      );
      const firstEvents: OmpTurnEvent[] = [];
      const secondEvents: OmpTurnEvent[] = [];
      try {
        await session.start();
        await expect(session.runTurn("first", (event) => firstEvents.push(event))).resolves.toEqual(
          { text: "PONG", cancelled: false, agentInvoked: true },
        );
        const settledEvents = [...firstEvents];
        if (timing === "idle") lateFrames(process);
        await expect(
          session.runTurn("second", (event) => secondEvents.push(event)),
        ).resolves.toEqual({ text: "PONG", cancelled: false, agentInvoked: true });
        expect(onFault).not.toHaveBeenCalled();
        expect(firstEvents).toEqual(settledEvents);
        for (const [events, callId] of [
          [firstEvents, "old-tool"],
          [secondEvents, "new-tool"],
        ] as const) {
          expect(events.filter((event) => event.type.startsWith("tool."))).toEqual([
            { type: "tool.started", callId, toolName: "task", arguments: {} },
            { type: "tool.updated", callId, output: "working" },
            { type: "tool.completed", callId, toolName: "task", result: "done", isError: false },
          ]);
        }
      } finally {
        await session.close();
      }
    },
  );

  it.each([
    { label: "complete payload", payload: { toolName: "task", result: "done", isError: false } },
    { label: "missing payload", payload: {} },
  ])("ignores an unknown Tool end with $label", async ({ payload }) => {
    const process = new FakeOmpProcess("complete", undefined, "none", "none", (child) => {
      child.sendFrame({ type: "tool_execution_end", toolCallId: "never-started", ...payload });
    });
    const onFault = vi.fn();
    const session = new OmpRpcSession(
      { cwd: "/synthetic", commandTimeoutMs: 2_000, onFault },
      { spawn: () => process as never },
    );
    const events: OmpTurnEvent[] = [];
    try {
      await session.start();
      await expect(session.runTurn("hello", (event) => events.push(event))).resolves.toEqual({
        text: "PONG",
        cancelled: false,
        agentInvoked: true,
      });
      expect(onFault).not.toHaveBeenCalled();
      expect(events.filter((event) => event.type.startsWith("tool."))).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it.each([
    { label: "mismatched name", payload: { toolName: "bash", result: "done" } },
    { label: "missing name", payload: { result: "done" } },
    { label: "missing result", payload: { toolName: "task" } },
    {
      label: "non-boolean isError",
      payload: { toolName: "task", result: "done", isError: "false" },
    },
  ])("still faults on an active Tool end with $label", async ({ payload }) => {
    const process = new FakeOmpProcess("complete", undefined, "none", "none", (child) => {
      child.sendFrame({
        type: "tool_execution_start",
        toolCallId: "active-tool",
        toolName: "task",
        args: {},
      });
      child.sendFrame({ type: "tool_execution_end", toolCallId: "active-tool", ...payload });
    });
    const onFault = vi.fn();
    const session = new OmpRpcSession(
      { cwd: "/synthetic", commandTimeoutMs: 2_000, onFault },
      { spawn: () => process as never },
    );
    const events: OmpTurnEvent[] = [];
    try {
      await session.start();
      await expect(session.runTurn("hello", (event) => events.push(event))).rejects.toThrow(
        "Omp RPC returned an invalid Tool end",
      );
      expect(onFault).toHaveBeenCalledWith(expect.objectContaining({ kind: "protocolError" }));
      expect(events.filter((event) => event.type === "tool.completed")).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it.each(
    ["update", "end"].flatMap((kind) =>
      [
        { label: "missing", callId: undefined },
        { label: "empty", callId: "" },
        { label: "numeric", callId: 42 },
        { label: "null", callId: null },
      ].map((entry) => ({ kind, ...entry })),
    ),
  )("still faults on a Tool $kind with a $label ID", async ({ kind, callId }) => {
    const process = new FakeOmpProcess("complete", undefined, "none", "none", (child) => {
      child.sendFrame({
        type: `tool_execution_${kind}`,
        toolCallId: callId,
        toolName: "task",
        partialResult: "working",
        result: "done",
      });
    });
    const onFault = vi.fn();
    const session = new OmpRpcSession(
      { cwd: "/synthetic", commandTimeoutMs: 2_000, onFault },
      { spawn: () => process as never },
    );
    const events: OmpTurnEvent[] = [];
    try {
      await session.start();
      await expect(session.runTurn("hello", (event) => events.push(event))).rejects.toThrow(
        `Omp RPC returned an invalid Tool ${kind}`,
      );
      expect(onFault).toHaveBeenCalledWith(expect.objectContaining({ kind: "protocolError" }));
      expect(events.filter((event) => event.type.startsWith("tool."))).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it.each([false, 0, "", null])("preserves valid Tool output %j", async (output) => {
    const process = new FakeOmpProcess("complete", undefined, "none", "none", (child) => {
      child.sendFrame({
        type: "tool_execution_start",
        toolCallId: "active-tool",
        toolName: "task",
        args: {},
      });
      child.sendFrame({
        type: "tool_execution_update",
        toolCallId: "active-tool",
        partialResult: output,
      });
      child.sendFrame({
        type: "tool_execution_end",
        toolCallId: "active-tool",
        toolName: "task",
        result: output,
        isError: false,
      });
    });
    const onFault = vi.fn();
    const session = new OmpRpcSession(
      { cwd: "/synthetic", commandTimeoutMs: 2_000, onFault },
      { spawn: () => process as never },
    );
    const events: OmpTurnEvent[] = [];
    try {
      await session.start();
      await expect(session.runTurn("hello", (event) => events.push(event))).resolves.toEqual({
        text: "PONG",
        cancelled: false,
        agentInvoked: true,
      });
      expect(onFault).not.toHaveBeenCalled();
      expect(events.filter((event) => event.type.startsWith("tool."))).toEqual([
        { type: "tool.started", callId: "active-tool", toolName: "task", arguments: {} },
        { type: "tool.updated", callId: "active-tool", output },
        {
          type: "tool.completed",
          callId: "active-tool",
          toolName: "task",
          result: output,
          isError: false,
        },
      ]);
    } finally {
      await session.close();
    }
  });

  it("does not replay Assistant messages from agent_end after message_end", async () => {
    const process = new FakeOmpProcess("complete", undefined, "replay");
    const adapter: OmpRpcProcessAdapter = { spawn: () => process as never };
    const session = new OmpRpcSession({ cwd: "/synthetic", commandTimeoutMs: 2_000 }, adapter);
    await session.start();
    const events: OmpTurnEvent[] = [];

    await expect(session.runTurn("hello", (event) => events.push(event))).resolves.toEqual({
      text: "PONG",
      cancelled: false,
      agentInvoked: true,
    });
    expect(events.filter((event) => event.type === "text.delta")).toEqual([
      { type: "text.delta", messageId: "assistant-1", delta: "PONG" },
    ]);
    expect(events.filter((event) => event.type === "message.completed")).toEqual([
      { type: "message.completed", messageId: "assistant-1" },
    ]);
    await session.close();
  });

  it("recovers the final Assistant message from agent_end when message_end is absent", async () => {
    const process = new FakeOmpProcess("complete", undefined, "fallback");
    const adapter: OmpRpcProcessAdapter = { spawn: () => process as never };
    const session = new OmpRpcSession({ cwd: "/synthetic", commandTimeoutMs: 2_000 }, adapter);
    await session.start();
    const events: OmpTurnEvent[] = [];

    await expect(session.runTurn("hello", (event) => events.push(event))).resolves.toEqual({
      text: "PONG",
      cancelled: false,
      agentInvoked: true,
    });
    expect(events.filter((event) => event.type === "text.delta")).toEqual([
      { type: "text.delta", messageId: "assistant-1", delta: "PONG" },
    ]);
    expect(events.filter((event) => event.type === "message.completed")).toEqual([
      { type: "message.completed", messageId: "assistant-1" },
    ]);
    await session.close();
  });

  it("bridges blocking OMP RPC UI requests and sends the selected response", async () => {
    const process = new FakeOmpProcess("complete", undefined, "approval");
    const adapter: OmpRpcProcessAdapter = { spawn: () => process as never };
    const session = new OmpRpcSession({ cwd: "/synthetic", commandTimeoutMs: 2_000 }, adapter);
    await session.start();
    const events: OmpTurnEvent[] = [];
    const turn = session.runTurn("write", (event) => events.push(event));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toContainEqual({
      type: "interaction.requested",
      request: {
        requestId: "approval-1",
        method: "select",
        title: "Approve write?",
        options: ["Approve", "Deny"],
      },
    });

    await session.respondToInteraction({ requestId: "approval-1", value: "Approve" });
    expect(process.commands).toContainEqual({
      type: "extension_ui_response",
      id: "approval-1",
      value: "Approve",
    });
    expect(events).toContainEqual({
      type: "interaction.closed",
      requestId: "approval-1",
      reason: "responded",
    });
    await turn;
    await session.close();
  });

  it("retains aligned native question descriptions", async () => {
    const process = new FakeOmpProcess("complete", undefined, "approval", "none", undefined, {
      title: "Choose a storage format",
      options: ["JSON", "SQLite"],
      optionDetails: [{ description: "Portable file" }, {}],
    });
    const session = new OmpRpcSession(
      { cwd: "/synthetic", commandTimeoutMs: 2_000 },
      { spawn: () => process as never },
    );
    await session.start();
    const events: OmpTurnEvent[] = [];
    const turn = session.runTurn("choose", (event) => events.push(event));
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === "interaction.requested")).toBe(true),
    );
    expect(events).toContainEqual({
      type: "interaction.requested",
      request: {
        requestId: "approval-1",
        method: "select",
        title: "Choose a storage format",
        options: ["JSON", "SQLite"],
        optionDetails: [{ description: "Portable file" }, {}],
      },
    });
    await session.respondToInteraction({ requestId: "approval-1", value: "JSON" });
    await turn;
    await session.close();
  });

  it.each([
    { optionDetails: [] },
    { optionDetails: [{ description: 42 }, {}] },
    { optionDetails: [null, {}] },
  ])("rejects malformed or misaligned option descriptions: %j", async ({ optionDetails }) => {
    const process = new FakeOmpProcess("complete", undefined, "approval", "none", undefined, {
      optionDetails,
    });
    const session = new OmpRpcSession(
      { cwd: "/synthetic", commandTimeoutMs: 2_000 },
      { spawn: () => process as never },
    );
    await session.start();
    await expect(session.runTurn("choose", () => {})).rejects.toThrow("option details are invalid");
    await session.close();
  });

  it.each([true, false])(
    "distinguishes question expiry from cancellation: expired=%s",
    async (expired) => {
      const process = new FakeOmpProcess("complete", undefined, "approval", "none", undefined, {
        method: "input",
        title: "Name?",
        ...(expired ? { timeout: 10 } : {}),
      });
      const session = new OmpRpcSession(
        { cwd: "/synthetic", commandTimeoutMs: 2_000 },
        { spawn: () => process as never },
      );
      await session.start();
      const events: OmpTurnEvent[] = [];
      const turn = session.runTurn("ask", (event) => events.push(event));
      await vi.waitFor(() =>
        expect(events.some((event) => event.type === "interaction.requested")).toBe(true),
      );
      if (!expired)
        await session.respondToInteraction({ requestId: "approval-1", cancelled: true });
      await turn;
      expect(
        process.commands.filter((command) => command.type === "extension_ui_response"),
      ).toEqual([
        {
          type: "extension_ui_response",
          id: "approval-1",
          cancelled: true,
          ...(expired ? { timedOut: true } : {}),
        },
      ]);
      expect(events).toContainEqual({
        type: "interaction.closed",
        requestId: "approval-1",
        reason: expired ? "expired" : "cancelled",
      });
      await expect(
        session.respondToInteraction({ requestId: "approval-1", value: "late" }),
      ).rejects.toThrow("not pending");
      await session.close();
    },
  );

  it("projects Subagent lifecycle frames from the RPC stream", async () => {
    const process = new FakeOmpProcess();
    const adapter: OmpRpcProcessAdapter = { spawn: () => process as never };
    const session = new OmpRpcSession({ cwd: "/synthetic", commandTimeoutMs: 2_000 }, adapter);
    await session.start();
    const events: OmpTurnEvent[] = [];
    await session.runTurn("delegate", (event) => events.push(event));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "subagent.started",
        nativeSubagentId: "subagent-1",
        callId: "subagent-1",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "subagent.updated",
        nativeSubagentId: "subagent-1",
        status: "running",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "subagent.completed",
        nativeSubagentId: "subagent-1",
        isError: false,
      }),
    );
    await session.close();
  });

  it("projects every child in one native task batch without colliding on the parent Tool call", async () => {
    const process = new FakeOmpProcess("complete", undefined, "none", "none", (child) => {
      for (let index = 0; index < 4; index++) {
        child.sendFrame({
          type: "subagent_lifecycle",
          payload: {
            id: `batch-child-${index}`,
            parentToolCallId: "shared-task-call",
            status: "started",
            description: `Child ${index}`,
          },
        });
      }
      for (const index of [2, 0, 3, 1]) {
        child.sendFrame({
          type: "subagent_progress",
          payload: {
            parentToolCallId: "shared-task-call",
            progress: {
              id: `batch-child-${index}`,
              status: "running",
              recentOutput: [`Working ${index}`],
            },
          },
        });
        child.sendFrame({
          type: "subagent_lifecycle",
          payload: {
            id: `batch-child-${index}`,
            parentToolCallId: "shared-task-call",
            status: "completed",
            resultSummary: `Result ${index}`,
          },
        });
      }
    });
    const onFault = vi.fn();
    const session = new OmpRpcSession(
      { cwd: "/synthetic", commandTimeoutMs: 2_000, onFault },
      { spawn: () => process as never },
    );
    const events: HostEvent[] = [];
    let nextItemId = 0;
    const lifecycle = new OmpSubagentLifecycle({
      newItemId: () => hostItemIdSchema.parse(`delegation-${nextItemId++}`),
      emit: (event) => events.push(event),
    });
    const turnId = hostTurnIdSchema.parse("batch-turn");
    try {
      await session.start();
      await expect(
        session.runTurn("delegate batch", (event) => {
          if (event.type === "subagent.started") lifecycle.start(turnId, event);
          if (event.type === "subagent.updated") lifecycle.update(turnId, event);
          if (event.type === "subagent.completed") lifecycle.complete(turnId, event, false);
        }),
      ).resolves.toMatchObject({ text: "PONG", cancelled: false });
      expect(onFault).not.toHaveBeenCalled();
      const completed = events.filter(
        (event): event is Extract<HostEvent, { type: "item.completed" }> =>
          event.type === "item.completed" &&
          event.snapshot.item.type === "subagentDelegation" &&
          event.snapshot.item.subagents[0]?.nativeSubagentId?.startsWith("batch-child-") === true,
      );
      expect(completed).toHaveLength(4);
      expect(new Set(completed.map((event) => event.snapshot.item.itemId)).size).toBe(4);
      for (const event of completed) {
        if (event.snapshot.item.type !== "subagentDelegation") throw new Error("Wrong Item type");
        const subagent = event.snapshot.item.subagents[0];
        const index = subagent?.nativeSubagentId?.slice("batch-child-".length);
        expect(subagent).toMatchObject({ status: "completed", resultSummary: `Result ${index}` });
        expect(event.snapshot.outcome).toEqual({ status: "succeeded" });
      }
      expect(lifecycle.size).toBe(0);
    } finally {
      await session.close();
    }
  });

  it("keeps frame-handler faults distinct from invalid JSON", async () => {
    const process = new FakeOmpProcess();
    const session = new OmpRpcSession(
      { cwd: "/synthetic", commandTimeoutMs: 2_000 },
      { spawn: () => process as never },
    );
    try {
      await session.start();
      await expect(
        session.runTurn("delegate", () => {
          throw new Error("Synthetic projection failure");
        }),
      ).rejects.toThrow("Omp RPC frame handling failed: Synthetic projection failure");
    } finally {
      await session.close();
    }
  });

  it("keeps genuine duplicate child starts as faults", async () => {
    const process = new FakeOmpProcess("complete", undefined, "none", "none", (child) => {
      const frame = {
        type: "subagent_lifecycle",
        payload: { id: "same-child", parentToolCallId: "shared-task-call", status: "started" },
      };
      child.sendFrame(frame);
      child.sendFrame(frame);
    });
    const session = new OmpRpcSession(
      { cwd: "/synthetic", commandTimeoutMs: 2_000 },
      { spawn: () => process as never },
    );
    const lifecycle = new OmpSubagentLifecycle({
      newItemId: () => hostItemIdSchema.parse("duplicate-delegation"),
      emit: () => undefined,
    });
    try {
      await session.start();
      await expect(
        session.runTurn("duplicate", (event) => {
          if (event.type === "subagent.started") {
            lifecycle.start(hostTurnIdSchema.parse("duplicate-turn"), event);
          }
        }),
      ).rejects.toThrow(
        "Omp RPC frame handling failed: Omp Subagent delegation started more than once",
      );
    } finally {
      await session.close();
    }
  });

  it("preserves child identity for background Subagents sharing one parent Tool call", async () => {
    const process = new FakeOmpProcess();
    const events: OmpTurnEvent[] = [];
    const session = new OmpRpcSession(
      { cwd: "/synthetic", onSubagentEvent: (event) => events.push(event) },
      { spawn: () => process as never },
    );
    try {
      await session.start();
      for (const id of ["background-child-1", "background-child-2"]) {
        process.sendFrame({
          type: "subagent_lifecycle",
          payload: {
            id,
            parentToolCallId: "shared-background-tool",
            status: "started",
            detached: true,
          },
        });
      }
      expect(events).toMatchObject([
        {
          type: "subagent.started",
          callId: "background-child-1",
          nativeSubagentId: "background-child-1",
        },
        {
          type: "subagent.started",
          callId: "background-child-2",
          nativeSubagentId: "background-child-2",
        },
      ]);
    } finally {
      await session.close();
    }
  });

  it("still reports malformed JSONL as a parsing fault", async () => {
    const process = new FakeOmpProcess();
    const onFault = vi.fn();
    const session = new OmpRpcSession(
      { cwd: "/synthetic", commandTimeoutMs: 2_000, onFault },
      { spawn: () => process as never },
    );
    try {
      await session.start();
      process.stdout.write("{not-json}\n");
      expect(onFault).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "protocolError",
          message: expect.stringContaining("invalid JSONL"),
        }),
      );
    } finally {
      await session.close();
    }
  });

  it("correlates manual Compact RPC events without an active Prompt Turn", async () => {
    const process = new FakeOmpProcess();
    const adapter: OmpRpcProcessAdapter = { spawn: () => process as never };
    const session = new OmpRpcSession({ cwd: "/synthetic", commandTimeoutMs: 2_000 }, adapter);
    const events: OmpTurnEvent[] = [];
    await session.start();

    await expect(
      session.compact("Keep implementation details", (event) => events.push(event)),
    ).resolves.toEqual({ outcome: "succeeded" });
    expect(events).toEqual([
      { type: "compaction.started" },
      { type: "compaction.completed", outcome: "succeeded" },
    ]);
    await session.close();
  });

  it("fails a manual Compact when native compaction never reaches a terminal event", async () => {
    const process = new FakeOmpProcess("stalled");
    const adapter: OmpRpcProcessAdapter = { spawn: () => process as never };
    const onFault = vi.fn();
    const session = new OmpRpcSession(
      {
        cwd: "/synthetic",
        commandTimeoutMs: 10,
        compactionTimeoutMs: 20,
        onFault,
      },
      adapter,
    );
    await session.start();

    await expect(session.compact(undefined, () => undefined)).rejects.toThrow(
      "compaction timed out after 20ms",
    );
    expect(onFault).toHaveBeenCalledWith(expect.objectContaining({ kind: "protocolError" }));
    await session.close();
  });

  it.each(["new-empty", "new-with-messages", "resumed", "forked"])(
    "handles an uncreated Session file only for confirmed empty new Sessions: %s",
    async (mode) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-omp-lazy-history-"));
      const sessionFile = path.join(directory, "session.jsonl");
      const process = new FakeOmpProcess("complete", sessionFile);
      if (mode === "new-with-messages")
        process.messages = [{ role: "user", content: "persist me" }];
      const session = new OmpRpcSession(
        {
          cwd: directory,
          ...(mode === "resumed" ? { sessionFile } : {}),
          ...(mode === "forked" ? { forkSessionFile: sessionFile } : {}),
        },
        { spawn: () => process as never },
      );
      try {
        await session.start();
        if (mode === "new-empty") {
          await expect(session.getEntries()).resolves.toEqual({ entries: [], leafId: null });
          await writeFile(
            sessionFile,
            [
              { type: "session", version: 3, id: "omp-session", cwd: directory },
              {
                type: "message",
                id: "native-user",
                parentId: null,
                message: { role: "user", content: "next prompt" },
              },
            ]
              .map((entry) => JSON.stringify(entry))
              .join("\n") + "\n",
          );
          await expect(session.getEntries()).resolves.toMatchObject({
            entries: [{ id: "native-user", parentId: null }],
            leafId: "native-user",
          });
        } else {
          await expect(session.getEntries()).rejects.toMatchObject({ code: "ENOENT" });
        }
      } finally {
        await session.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("reads the persisted full transcript when OMP's compacted RPC context omits User messages", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-omp-rpc-history-"));
    const sessionFile = path.join(directory, "session.jsonl");
    await writeFile(
      sessionFile,
      [
        { type: "title", title: "Compacted session" },
        { type: "session", version: 3, id: "omp-session", cwd: directory },
        {
          type: "message",
          id: "user-1",
          parentId: null,
          message: { role: "user", content: [{ type: "text", text: "original prompt" }] },
        },
        {
          type: "message",
          id: "assistant-1",
          parentId: "user-1",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "original answer" }],
            stopReason: "stop",
          },
        },
        {
          type: "compaction",
          id: "compaction-1",
          parentId: "assistant-1",
          summary: "Compacted context",
          firstKeptEntryId: "assistant-1",
          tokensBefore: 100,
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    const process = new FakeOmpProcess("complete", sessionFile);
    const adapter: OmpRpcProcessAdapter = { spawn: () => process as never };
    const session = new OmpRpcSession(
      { cwd: directory, sessionFile, commandTimeoutMs: 2_000 },
      adapter,
    );

    try {
      await session.start();
      await expect(session.getEntries()).resolves.toMatchObject({
        leafId: "compaction-1",
        entries: [
          { id: "user-1", parentId: null, type: "message" },
          { id: "assistant-1", parentId: "user-1", type: "message" },
          { id: "compaction-1", parentId: "assistant-1", type: "compaction" },
        ],
      });
      expect(process.commands).not.toContainEqual(
        expect.objectContaining({ type: "get_messages" }),
      );
    } finally {
      await session.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("branches to a distinct OMP session through the RPC branch command", async () => {
    const process = new FakeOmpProcess();
    const adapter: OmpRpcProcessAdapter = { spawn: () => process as never };
    const session = new OmpRpcSession({ cwd: "/synthetic", commandTimeoutMs: 2_000 }, adapter);
    await session.start();
    await expect(session.fork("entry-1")).resolves.toMatchObject({
      sessionId: "omp-forked-session",
    });
    await session.close();
  });

  it("reads a Subagent transcript through OMP RPC", async () => {
    const process = new FakeOmpProcess();
    const adapter: OmpRpcProcessAdapter = { spawn: () => process as never };
    const session = new OmpRpcSession({ cwd: "/synthetic", commandTimeoutMs: 2_000 }, adapter);
    await session.start();
    await expect(
      session.getSubagentMessages({ subagentId: "subagent-1", fromByte: 7 }),
    ).resolves.toMatchObject({
      sessionFile: "/tmp/subagent.jsonl",
      fromByte: 7,
      nextByte: 42,
    });
    await session.close();
  });

  it("forwards background Subagent frames after the parent Turn is idle", async () => {
    const process = new FakeOmpProcess();
    const adapter: OmpRpcProcessAdapter = { spawn: () => process as never };
    const events: OmpTurnEvent[] = [];
    const session = new OmpRpcSession(
      {
        cwd: "/synthetic",
        commandTimeoutMs: 2_000,
        onSubagentEvent: (event) => events.push(event),
      },
      adapter,
    );
    await session.start();
    process.stdout.write(
      `${JSON.stringify({
        type: "subagent_progress",
        payload: {
          index: 0,
          agent: "task",
          agentSource: "bundled",
          progress: { id: "subagent-1", status: "running", recentOutput: ["still working"] },
          parentToolCallId: "tool-1",
        },
      })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "subagent.updated",
        nativeSubagentId: "subagent-1",
        resultSummary: "still working",
      }),
    );
    await session.close();
  });
});
