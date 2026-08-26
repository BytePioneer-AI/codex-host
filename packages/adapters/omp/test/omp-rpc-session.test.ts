import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

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
  #buffer = "";
  #sessionId = "omp-session";

  constructor() {
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
    };
  }

  #handle(command: Record<string, unknown>): void {
    this.commands.push(command);
    if (command.type === "negotiate_protocol")
      return this.#response(command, { protocolVersion: 2 });
    if (command.type === "get_state") return this.#response(command, this.#state());
    if (command.type === "get_messages") return this.#response(command, { messages: [] });
    if (command.type === "new_session") {
      this.#sessionId = "omp-new-session";
      return this.#response(command, { cancelled: false });
    }
    if (command.type === "handoff") {
      return this.#response(command, { savedPath: "/tmp/omp-handoff.md" });
    }
    if (command.type === "set_subagent_subscription") {
      return this.#response(command, { level: command.level });
    }
    if (command.type === "set_host_tools") {
      const tools = Array.isArray(command.tools) ? command.tools : [];
      return this.#response(command, {
        toolNames: tools.flatMap((tool) =>
          typeof tool === "object" &&
          tool !== null &&
          !Array.isArray(tool) &&
          typeof tool.name === "string"
            ? [tool.name]
            : [],
        ),
      });
    }
    if (command.type === "set_host_uri_schemes") {
      const schemes = Array.isArray(command.schemes) ? command.schemes : [];
      return this.#response(command, {
        schemes: schemes.flatMap((scheme) =>
          typeof scheme === "object" &&
          scheme !== null &&
          !Array.isArray(scheme) &&
          typeof scheme.scheme === "string"
            ? [scheme.scheme]
            : [],
        ),
      });
    }
    if (command.type === "get_subagents") {
      return this.#response(command, {
        subagents: [
          {
            id: "subagent-1",
            index: 0,
            agent: "task",
            agentSource: "bundled",
            description: "Inspect the repository",
            status: "running",
            sessionFile: "/tmp/subagent.jsonl",
            parentToolCallId: "tool-1",
            lastUpdate: 1,
          },
        ],
      });
    }
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
    if (command.type === "prompt") {
      this.#response(command);
      queueMicrotask(() => {
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
        this.#output({
          type: "message_update",
          message,
          assistantMessageEvent: { type: "text_delta", delta: "PONG" },
        });
        this.#output({ type: "message_end", message: { ...message, stopReason: "stop" } });
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
        this.#output({ type: "agent_end", isTerminal: true });
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

  it("reads Subagent registry and transcript through OMP RPC", async () => {
    const process = new FakeOmpProcess();
    const adapter: OmpRpcProcessAdapter = { spawn: () => process as never };
    const session = new OmpRpcSession({ cwd: "/synthetic", commandTimeoutMs: 2_000 }, adapter);
    await session.start();
    await expect(session.setSubagentSubscription("progress")).resolves.toBe("progress");
    await expect(session.getSubagents()).resolves.toMatchObject([
      { id: "subagent-1", status: "running", sessionFile: "/tmp/subagent.jsonl" },
    ]);
    await expect(
      session.getSubagentMessages({ subagentId: "subagent-1", fromByte: 7 }),
    ).resolves.toMatchObject({
      sessionFile: "/tmp/subagent.jsonl",
      fromByte: 7,
      nextByte: 42,
    });
    await session.close();
  });

  it("registers configured Host Tools and URI schemes during startup", async () => {
    const process = new FakeOmpProcess();
    const adapter: OmpRpcProcessAdapter = { spawn: () => process as never };
    const session = new OmpRpcSession(
      {
        cwd: "/synthetic",
        commandTimeoutMs: 2_000,
        hostTools: [
          {
            name: "lookup",
            description: "Look up a value",
            parameters: { type: "object" },
            execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
          },
        ],
        hostUriSchemes: [
          {
            scheme: "docs",
            async resolve() {
              return { content: "docs" };
            },
          },
        ],
      },
      adapter,
    );
    await session.start();
    expect(process.commands).toContainEqual(
      expect.objectContaining({
        type: "set_host_tools",
        tools: [{ name: "lookup", description: "Look up a value", parameters: { type: "object" } }],
      }),
    );
    expect(process.commands).toContainEqual(
      expect.objectContaining({
        type: "set_host_uri_schemes",
        schemes: [{ scheme: "docs" }],
      }),
    );
    await session.close();
  });

  it("runs OMP handoff and refreshes the confirmed session state", async () => {
    const process = new FakeOmpProcess();
    const adapter: OmpRpcProcessAdapter = { spawn: () => process as never };
    const session = new OmpRpcSession({ cwd: "/synthetic", commandTimeoutMs: 2_000 }, adapter);
    await session.start();
    await expect(session.handoff("Focus on the remaining risks")).resolves.toMatchObject({
      savedPath: "/tmp/omp-handoff.md",
      state: { sessionId: "omp-session" },
    });
    expect(process.commands).toContainEqual(
      expect.objectContaining({
        type: "handoff",
        customInstructions: "Focus on the remaining risks",
      }),
    );
    await session.close();
  });

  it("forwards OMP steering, follow-up, queue-mode, rename, and new-session commands", async () => {
    const process = new FakeOmpProcess();
    const adapter: OmpRpcProcessAdapter = { spawn: () => process as never };
    const session = new OmpRpcSession({ cwd: "/synthetic", commandTimeoutMs: 2_000 }, adapter);
    await session.start();

    await expect(session.steer("Stop and inspect the failing test")).resolves.toBeUndefined();
    await expect(session.followUp("Then summarize the remaining risks")).resolves.toBeUndefined();
    await expect(session.setSteeringMode("one-at-a-time")).resolves.toBeUndefined();
    await expect(session.setFollowUpMode("all")).resolves.toBeUndefined();
    await expect(session.setSessionName("OMP integration")).resolves.toBeUndefined();
    await expect(session.newSession("/tmp/parent-session.jsonl")).resolves.toMatchObject({
      cancelled: false,
      state: { sessionId: "omp-new-session" },
    });

    expect(process.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "steer", message: "Stop and inspect the failing test" }),
        expect.objectContaining({
          type: "follow_up",
          message: "Then summarize the remaining risks",
        }),
        expect.objectContaining({ type: "set_steering_mode", mode: "one-at-a-time" }),
        expect.objectContaining({ type: "set_follow_up_mode", mode: "all" }),
        expect.objectContaining({ type: "set_session_name", name: "OMP integration" }),
        expect.objectContaining({
          type: "new_session",
          parentSession: "/tmp/parent-session.jsonl",
        }),
      ]),
    );
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
