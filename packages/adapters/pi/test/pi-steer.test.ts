import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough } from "node:stream";

import type { HarnessOutput, HarnessSession, HostEvent } from "@codexhost/harness-adapter";
import { harnessThinkingOptionIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PiAdapter, type PiTurnTransport } from "../src/pi-adapter.js";
import type { PiSessionHistory } from "../src/pi-history.js";
import {
  PiRpcSession,
  type PiRpcProcessAdapter,
  type PiSessionState,
  type PiTurnEvent,
  type PiTurnResult,
} from "../src/pi-rpc-session.js";

const adapters: PiAdapter[] = [];

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
});

class SteerPiTransport implements PiTurnTransport {
  readonly abort = vi.fn(async () => {
    this.resolveTurn?.({ text: "", cancelled: true });
  });
  readonly steer = vi.fn(async () => undefined);
  readonly setAutonomousTurnHandler = vi.fn();
  state: PiSessionState = {
    sessionId: "pi-session-1",
    sessionFile: "/synthetic/pi-session.jsonl",
    provider: "synthetic-provider",
    modelId: "synthetic-model",
    thinkingLevel: harnessThinkingOptionIdSchema.parse("off"),
    contextUsage: null,
  };
  history: PiSessionHistory = { entries: [], leafId: null };
  onEvent: ((event: PiTurnEvent) => void) | null = null;
  resolveTurn: ((result: PiTurnResult) => void) | null = null;

  async start(): Promise<void> {}
  async getAvailableModels() {
    return [{ provider: "synthetic-provider", id: "synthetic-model", reasoning: false }];
  }
  async getAvailableThinkingLevels() {
    return [harnessThinkingOptionIdSchema.parse("off")];
  }
  async getEntries(): Promise<PiSessionHistory> {
    return this.history;
  }
  async getSessionUsage() {
    return null;
  }
  async fork() {
    return this.state;
  }
  async clone() {
    return this.state;
  }
  async verifySessionCwd(): Promise<void> {}
  async selectModel() {
    return this.state;
  }
  async selectThinkingOption() {
    return this.state;
  }
  async compact() {
    return { outcome: "succeeded" as const };
  }
  runTurn(_text: string, onEvent: (event: PiTurnEvent) => void): Promise<PiTurnResult> {
    this.onEvent = onEvent;
    return new Promise((resolve) => {
      this.resolveTurn = resolve;
    });
  }
  async respondToInteraction(): Promise<void> {}
  async close(): Promise<void> {}
}

function openAdapter() {
  const transports: SteerPiTransport[] = [];
  const adapter = new PiAdapter(
    {},
    {
      createTransport: () => {
        const transport = new SteerPiTransport();
        transports.push(transport);
        return transport;
      },
    },
  );
  adapters.push(adapter);
  return { adapter, transports };
}

async function openSession() {
  const opened = openAdapter();
  const result = await opened.adapter.open({ kind: "create", cwd: "/synthetic" });
  if (!result.ok) throw new Error(result.error.message);
  const outputs: HarnessOutput[] = [];
  void (async () => {
    for await (const output of result.value.outputs) outputs.push(output);
  })();
  return { ...opened, session: result.value, outputs };
}

function hostEvents(outputs: HarnessOutput[]): HostEvent[] {
  return outputs.flatMap((output) => (output.kind === "event" ? [output.event] : []));
}

function userMessageEvents(outputs: HarnessOutput[]) {
  return hostEvents(outputs).filter(
    (event) =>
      (event.type === "item.started" && event.item.type === "userMessage") ||
      (event.type === "item.completed" && event.snapshot.item.type === "userMessage"),
  );
}

function historyOf(userTexts: string[]): PiSessionHistory {
  let parentId: string | null = null;
  const entries: PiSessionHistory["entries"] = [];
  userTexts.forEach((text, index) => {
    const userId = `user-${index + 1}`;
    const assistantId = `assistant-${index + 1}`;
    entries.push(
      {
        id: userId,
        parentId,
        type: "message",
        message: { role: "user", content: [{ type: "text", text }] },
      },
      {
        id: assistantId,
        parentId: userId,
        type: "message",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "answer" }],
        },
      },
    );
    parentId = assistantId;
  });
  return { entries, leafId: parentId };
}

describe("Pi steer capability", () => {
  it("declares steer on the session and on inspect", async () => {
    const opened = await openSession();
    expect(opened.session.capabilities.steer).toBe(true);
    const inspected = await opened.adapter.inspect({ cwd: "/synthetic", refresh: true });
    expect(inspected.status === "ready" ? inspected.capabilities.steer : false).toBe(true);
  });
});

describe("Pi turn.steer", () => {
  async function startTurn(session: HarnessSession, turnId = "turn-1") {
    const id = hostTurnIdSchema.parse(turnId);
    await expect(
      session.execute({
        type: "turn.start",
        turnId: id,
        input: [{ type: "text", text: "run the tool" }],
      }),
    ).resolves.toMatchObject({ ok: true, value: { turnId: id } });
    return id;
  }

  it("inserts into the active turn without publishing a user message", async () => {
    const { session, transports, outputs } = await openSession();
    const turnId = await startTurn(session);
    const transport = transports[0];
    if (!transport) throw new Error("Missing transport");
    await expect(
      session.execute({
        type: "turn.steer",
        turnId,
        input: [
          { type: "text", text: "line one" },
          { type: "text", text: "line two" },
        ],
      }),
    ).resolves.toEqual({ ok: true, value: { accepted: true } });
    await expect(
      session.execute({
        type: "turn.steer",
        turnId,
        input: [{ type: "text", text: "second" }],
      }),
    ).resolves.toEqual({ ok: true, value: { accepted: true } });
    expect(transport.steer).toHaveBeenNthCalledWith(1, "line one\nline two");
    expect(transport.steer).toHaveBeenNthCalledWith(2, "second");
    expect(transport.abort).not.toHaveBeenCalled();
    expect(userMessageEvents(outputs)).toEqual([]);

    await expect(
      session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("turn-2"),
        input: [{ type: "text", text: "another" }],
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "sessionBusy" } });

    transport.history = historyOf(["run the tool", "line one\nline two", "second"]);
    transport.resolveTurn?.({ text: "pong", cancelled: false });
    await vi.waitFor(() => {
      expect(hostEvents(outputs).some((event) => event.type === "turn.completed")).toBe(true);
    });
    expect(hostEvents(outputs).find((event) => event.type === "turn.completed")).toMatchObject({
      turnId,
      nativeTurnRef: { nativeTurnKey: "user-1" },
      outcome: { status: "succeeded", checkpoint: { checkpointId: "user-1" } },
    });
    expect(userMessageEvents(outputs)).toEqual([]);
  });

  it("waits for an accepted steer before completing and closes steer admission", async () => {
    const { session, transports, outputs } = await openSession();
    const turnId = await startTurn(session);
    const transport = transports[0];
    if (!transport) throw new Error("Missing transport");
    const accepted = Promise.withResolvers<undefined>();
    transport.steer.mockImplementationOnce(() => accepted.promise);
    const steering = session.execute({
      type: "turn.steer",
      turnId,
      input: [{ type: "text", text: "reply pong" }],
    });
    await vi.waitFor(() => expect(transport.steer).toHaveBeenCalledOnce());

    transport.history = historyOf(["run the tool", "reply pong"]);
    transport.resolveTurn?.({ text: "pong", cancelled: false });
    await Promise.resolve();
    await expect(
      session.execute({
        type: "turn.steer",
        turnId,
        input: [{ type: "text", text: "too late" }],
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidState" } });

    accepted.resolve(undefined);
    await expect(steering).resolves.toEqual({ ok: true, value: { accepted: true } });
    await vi.waitFor(() => {
      expect(hostEvents(outputs).some((event) => event.type === "turn.completed")).toBe(true);
    });
    expect(hostEvents(outputs).find((event) => event.type === "turn.completed")).toMatchObject({
      turnId,
      nativeTurnRef: { nativeTurnKey: "user-1" },
      outcome: { status: "succeeded", checkpoint: { checkpointId: "user-1" } },
    });
    expect(transport.steer).toHaveBeenCalledOnce();
  });

  it("keeps the original prompt when one steer adds exactly one user entry", async () => {
    const { session, transports, outputs } = await openSession();
    const turnId = await startTurn(session);
    const transport = transports[0];
    if (!transport) throw new Error("Missing transport");
    await session.execute({
      type: "turn.steer",
      turnId,
      input: [{ type: "text", text: "reply pong" }],
    });
    transport.history = historyOf(["run the tool", "reply pong"]);
    transport.resolveTurn?.({ text: "pong", cancelled: false });
    await vi.waitFor(() => {
      expect(hostEvents(outputs).some((event) => event.type === "turn.completed")).toBe(true);
    });
    expect(hostEvents(outputs).find((event) => event.type === "turn.completed")).toMatchObject({
      nativeTurnRef: { nativeTurnKey: "user-1" },
      outcome: { status: "succeeded" },
    });
  });

  it("still fails when the new user entry count does not match accepted steers", async () => {
    const { session, transports, outputs } = await openSession();
    const turnId = await startTurn(session);
    const transport = transports[0];
    if (!transport) throw new Error("Missing transport");
    await session.execute({
      type: "turn.steer",
      turnId,
      input: [{ type: "text", text: "reply pong" }],
    });
    transport.history = historyOf(["run the tool"]);
    transport.resolveTurn?.({ text: "pong", cancelled: false });
    await vi.waitFor(() => {
      expect(hostEvents(outputs).some((event) => event.type === "turn.completed")).toBe(true);
    });
    expect(hostEvents(outputs).find((event) => event.type === "turn.completed")).toMatchObject({
      outcome: {
        status: "failed",
        error: { code: "protocolError", message: expect.stringContaining("exactly 2 is required") },
      },
    });

    const extra = await openSession();
    const extraTurn = await startTurn(extra.session, "turn-extra");
    const extraTransport = extra.transports[0];
    if (!extraTransport) throw new Error("Missing transport");
    extraTransport.history = historyOf(["run the tool", "other client"]);
    extraTransport.resolveTurn?.({ text: "pong", cancelled: false });
    await vi.waitFor(() => {
      expect(hostEvents(extra.outputs).some((event) => event.type === "turn.completed")).toBe(true);
    });
    expect(
      hostEvents(extra.outputs).find((event) => event.type === "turn.completed"),
    ).toMatchObject({
      turnId: extraTurn,
      outcome: {
        status: "failed",
        error: { code: "protocolError", message: expect.stringContaining("exactly 1 is required") },
      },
    });
  });

  it("rejects an inactive turn, an empty steer, a native rejection, and a closed session", async () => {
    const { session, transports } = await openSession();
    const turnId = await startTurn(session);
    const transport = transports[0];
    await expect(
      session.execute({
        type: "turn.steer",
        turnId: hostTurnIdSchema.parse("other-turn"),
        input: [{ type: "text", text: "reply pong" }],
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidState" } });
    await expect(
      session.execute({
        type: "turn.steer",
        turnId,
        input: [{ type: "text", text: "" }],
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    expect(transport?.steer).not.toHaveBeenCalled();
    transport?.steer.mockRejectedValueOnce(new Error("Pi RPC steer was not accepted"));
    await expect(
      session.execute({
        type: "turn.steer",
        turnId,
        input: [{ type: "text", text: "reply pong" }],
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "invalidState", message: "Pi RPC steer was not accepted" },
    });
    await session.close();
    await expect(
      session.execute({
        type: "turn.steer",
        turnId,
        input: [{ type: "text", text: "reply pong" }],
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidState" } });
  });
});

describe("Pi RPC steer", () => {
  it("sends steer and ignores the user echo", async () => {
    const fake = new FakePiProcess();
    const processAdapter: PiRpcProcessAdapter = {
      spawn: () => fake as unknown as ChildProcessWithoutNullStreams,
    };
    const rpc = new PiRpcSession(
      { cwd: process.cwd(), commandTimeoutMs: 2_000, closeTimeoutMs: 500 },
      processAdapter,
    );
    const events: PiTurnEvent[] = [];
    await rpc.start();
    const running = rpc.runTurn("run the tool", (event) => events.push(event));
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "tool.completed")).toBe(true);
    });
    await rpc.steer("reply pong");
    await expect(running).resolves.toMatchObject({ text: "pong", cancelled: false });
    expect(fake.steered).toEqual(["reply pong"]);
    const text = events.flatMap((event) => (event.type === "text.delta" ? [event.delta] : []));
    expect(text.join("")).toBe("pong");
    await rpc.close();
  });

  it("rejects a steer the native session does not accept", async () => {
    const fake = new FakePiProcess();
    fake.rejectSteer = "Agent is idle";
    const rpc = new PiRpcSession(
      { cwd: process.cwd(), commandTimeoutMs: 2_000, closeTimeoutMs: 500 },
      { spawn: () => fake as unknown as ChildProcessWithoutNullStreams },
    );
    await rpc.start();
    await expect(rpc.steer("reply pong")).rejects.toThrow("Agent is idle");
    await rpc.close();
  });
});

class FakePiProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 42_001;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly steered: string[] = [];
  rejectSteer: string | null = null;
  #buffer = Buffer.alloc(0);

  constructor() {
    super();
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
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    let newline = this.#buffer.indexOf(0x0a);
    while (newline >= 0) {
      const line = this.#buffer.subarray(0, newline).toString("utf8");
      this.#buffer = this.#buffer.subarray(newline + 1);
      this.#onCommand(JSON.parse(line) as Record<string, unknown>);
      newline = this.#buffer.indexOf(0x0a);
    }
  }

  #onCommand(command: Record<string, unknown>): void {
    if (command.type === "prompt") {
      this.#respond(command);
      this.#output({
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "echo hello" },
      });
      this.#output({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "bash",
        result: { output: "hello" },
        isError: false,
      });
      return;
    }
    if (command.type === "steer") {
      if (this.rejectSteer) {
        this.#output({
          id: command.id,
          type: "response",
          command: "steer",
          success: false,
          error: this.rejectSteer,
        });
        return;
      }
      if (typeof command.message === "string") this.steered.push(command.message);
      this.#respond(command);
      const user = { role: "user", content: [{ type: "text", text: command.message }] };
      const assistant = {
        role: "assistant",
        content: [{ type: "text", text: "pong" }],
        stopReason: "stop",
      };
      this.#output({ type: "message_start", message: user });
      this.#output({ type: "message_end", message: user });
      this.#output({ type: "message_end", message: assistant });
      this.#output({ type: "agent_settled" });
      return;
    }
    this.#respond(command, {
      sessionId: "pi-session",
      sessionFile: null,
      model: { provider: "synthetic", id: "model" },
      thinkingLevel: "off",
      isStreaming: false,
    });
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
