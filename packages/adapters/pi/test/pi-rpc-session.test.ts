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
  | "assistant-error"
  | "retry-success"
  | "empty"
  | "tools"
  | "cancel"
  | "malformed-tool"
  | "interaction"
  | "interaction-timeout"
  | "interaction-cancel"
  | "malformed-interaction"
  | "malformed-catalog"
  | "malformed-thinking"
  | "unsupported-thinking"
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
      this.#respond(command, {
        ...(this.#scenario === "missing-session-id" ? {} : { sessionId: this.#sessionId }),
        sessionFile: this.#sessionFile,
        model: { provider: this.#provider, id: this.#modelId },
        thinkingLevel: this.#thinkingLevel,
      });
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
      (this.#scenario === "cancel" || this.#scenario === "interaction-cancel")
    ) {
      if (this.#scenario === "cancel") {
        this.#output({
          type: "tool_execution_end",
          toolCallId: "long-tool",
          toolName: "gate_long_tool",
          result: { content: [{ type: "text", text: "cancelled" }] },
          isError: true,
        });
      }
      this.#output({ type: "agent_settled" });
      return;
    }
    if (command.type !== "prompt") return;
    this.#promptCount += 1;
    if (this.#scenario === "final-only" || (this.#scenario === "cancel" && this.#promptCount > 1)) {
      const text = this.#scenario === "cancel" ? "continued" : "synthetic final text";
      const message = { role: "assistant", content: [{ type: "text", text }] };
      this.#output({ type: "message_start", message });
      this.#output({ type: "message_end", message });
      this.#output({ type: "agent_settled" });
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
        this.#output({ type: "agent_settled" });
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
      this.#output({ type: "agent_settled" });
      return;
    }
    if (this.#scenario === "empty") {
      this.#output({ type: "agent_settled" });
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
    if (this.#scenario === "cancel") {
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
    this.#output({ type: "agent_settled" });
  }

  #toolEvents(): void {
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
    const message = { role: "assistant", content: [{ type: "text", text: "tools complete" }] };
    this.#output({ type: "message_start", message });
    this.#output({ type: "message_end", message });
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
  options: { turnTimeoutMs?: number } = {},
): PiRpcSession {
  const processAdapter: PiRpcProcessAdapter = {
    spawn() {
      return new FakePiRpcProcess(scenario) as unknown as ChildProcessWithoutNullStreams;
    },
  };
  return new PiRpcSession(
    {
      cwd: process.cwd(),
      commandTimeoutMs: 2_000,
      turnTimeoutMs: options.turnTimeoutMs ?? 2_000,
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
        turnTimeoutMs: 2_000,
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
    expect(events).toEqual([{ type: "text.delta", delta: "synthetic final text" }]);
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
    expect(events).toEqual([{ type: "text.delta", delta: "recovered" }]);
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
      text: "tools complete",
      cancelled: false,
    });
    expect(events.map(({ type }) => type)).toEqual([
      "tool.started",
      "tool.started",
      "tool.updated",
      "tool.updated",
      "tool.updated",
      "tool.completed",
      "tool.completed",
      "text.delta",
    ]);
    expect(events[2]).toMatchObject({
      type: "tool.updated",
      callId: "custom-1",
      output: { content: [{ text: "first" }] },
    });
    expect(events[4]).toMatchObject({
      type: "tool.updated",
      callId: "custom-1",
      output: { content: [{ text: "first second" }] },
    });
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

  it("faults and rejects a Tool Turn that cannot settle before its bound", async () => {
    const onFault = vi.fn();
    const rpc = session("cancel", onFault, { turnTimeoutMs: 10 });
    await rpc.start();

    await expect(rpc.runTurn("timeout", () => undefined)).rejects.toThrow("Pi Turn timed out");
    expect(onFault).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "protocolError", message: "Pi Turn timed out" }),
    );
    await rpc.close();
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
