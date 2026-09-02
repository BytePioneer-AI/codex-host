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

class FakeOmpProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 45_001;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly commands: Record<string, unknown>[] = [];
  extraPromptEvents: Record<string, unknown>[] = [];
  #buffer = "";
  #sessionId = "omp-session";

  constructor(
    readonly compactMode: "complete" | "stalled" = "complete",
    readonly sessionFile?: string,
    readonly terminalMessageMode: "none" | "replay" | "fallback" = "none",
    readonly holdPrompt = false,
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

  #handle(command: Record<string, unknown>): void {
    this.commands.push(command);
    if (command.type === "negotiate_protocol")
      return this.#response(command, { protocolVersion: 2 });
    if (command.type === "get_state") return this.#response(command, this.#state());
    if (command.type === "get_messages") return this.#response(command, { messages: [] });
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
      this.#response(command);
      if (this.holdPrompt) return;
      queueMicrotask(() => {
        for (const event of this.extraPromptEvents) this.#output(event);
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
    ).toMatchObject({ arguments: ["--mode", "rpc", "--resume", "/tmp/omp.jsonl"] });
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
    ).toMatchObject({ arguments: ["--mode", "rpc", "--approval-mode", "write"] });
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
    ).toMatchObject({ arguments: ["--mode", "rpc", "--approval-mode", "yolo"] });
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
    ).toMatchObject({ arguments: ["--mode", "rpc", "--fork", "/tmp/omp.jsonl"] });
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
    });
    expect(events).toContainEqual({ type: "text.delta", messageId: "assistant-1", delta: "PONG" });
    await session.close();
  });

  it("sends a native steer command during an active Turn", async () => {
    const process = new FakeOmpProcess("complete", undefined, "none", true);
    const adapter: OmpRpcProcessAdapter = { spawn: () => process as never };
    const session = new OmpRpcSession({ cwd: "/synthetic", commandTimeoutMs: 2_000 }, adapter);
    await session.start();
    const pending = session.runTurn("hello", () => undefined);
    await vi.waitFor(() => {
      expect(process.commands.some((command) => command.type === "prompt")).toBe(true);
    });
    await session.steer("use uppercase words");
    expect(process.commands).toContainEqual(
      expect.objectContaining({ type: "steer", message: "use uppercase words" }),
    );
    await session.close();
    await expect(pending).rejects.toThrow("Omp RPC Session closed");
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
    });
    expect(events.filter((event) => event.type === "text.delta")).toEqual([
      { type: "text.delta", messageId: "assistant-1", delta: "PONG" },
    ]);
    expect(events.filter((event) => event.type === "message.completed")).toEqual([
      { type: "message.completed", messageId: "assistant-1" },
    ]);
    await session.close();
  });

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
        callId: "tool-1",
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

  it("maps hyphenated terminal lifecycle frames as processes, not Subagents", async () => {
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
        type: "subagent_lifecycle",
        payload: {
          id: "term-1",
          status: "started",
          command: "bash --norc --noprofile",
          cwd: "/synthetic",
          pid: 1416880,
        },
      })}\n`,
    );
    process.stdout.write(
      `${JSON.stringify({
        type: "subagent_lifecycle",
        payload: {
          id: "terminal-3",
          status: "started",
          description: "counting loop",
          pid: 1416881,
        },
      })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual([
      expect.objectContaining({
        type: "process.state.changed",
        processId: "term-1",
        status: "running",
        command: "bash --norc --noprofile",
        osPid: 1416880,
      }),
      expect.objectContaining({
        type: "process.state.changed",
        processId: "terminal-3",
        status: "running",
        osPid: 1416881,
      }),
    ]);
    expect(events.some((event) => event.type.startsWith("subagent."))).toBe(false);
    await session.close();
  });

  it("ignores orphan and empty Tool updates instead of faulting the Session", async () => {
    const process = new FakeOmpProcess();
    process.extraPromptEvents = [
      {
        type: "tool_execution_update",
        toolCallId: "missing",
        partialResult: { content: [{ type: "text", text: "orphan" }] },
      },
      {
        type: "tool_execution_update",
        toolCallId: "also-missing",
      },
      {
        type: "tool_execution_start",
        toolCallId: "bash-1",
        toolName: "bash",
        args: { command: "echo hi" },
      },
      {
        type: "tool_execution_update",
        toolCallId: "bash-1",
      },
      {
        type: "tool_execution_update",
        toolCallId: "bash-1",
        partialResult: { content: [{ type: "text", text: "hi" }] },
      },
      {
        type: "tool_execution_end",
        toolCallId: "bash-1",
        toolName: "bash",
        result: { content: [{ type: "text", text: "hi" }] },
        isError: false,
      },
    ];
    const onFault = vi.fn();
    const adapter: OmpRpcProcessAdapter = { spawn: () => process as never };
    const session = new OmpRpcSession(
      { cwd: "/synthetic", commandTimeoutMs: 2_000, onFault },
      adapter,
    );
    await session.start();
    const events: OmpTurnEvent[] = [];

    await expect(session.runTurn("hello", (event) => events.push(event))).resolves.toEqual({
      text: "PONG",
      cancelled: false,
    });
    expect(onFault).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type.startsWith("tool."))).toEqual([
      {
        type: "tool.started",
        callId: "bash-1",
        toolName: "bash",
        arguments: { command: "echo hi" },
      },
      {
        type: "tool.updated",
        callId: "bash-1",
        output: { content: [{ type: "text", text: "hi" }] },
      },
      {
        type: "tool.completed",
        callId: "bash-1",
        toolName: "bash",
        result: { content: [{ type: "text", text: "hi" }] },
        isError: false,
      },
    ]);
    await session.close();
  });
});
