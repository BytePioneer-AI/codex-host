import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough } from "node:stream";

import type { HarnessOutput, HarnessSession, HostEvent } from "@codexhost/harness-adapter";
import { harnessThinkingOptionIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OmpAdapter, type OmpTurnTransport } from "../src/omp-adapter.js";
import type { OmpSessionHistory } from "../src/omp-history.js";
import {
  OmpRpcSession,
  OmpRpcSteerRejectedError,
  type OmpRpcProcessAdapter,
  type OmpSessionState,
  type OmpTurnEvent,
  type OmpTurnResult,
} from "../src/omp-rpc-session.js";

const adapters: OmpAdapter[] = [];

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
});

class SteerOmpTransport implements OmpTurnTransport {
  readonly abort = vi.fn(async () => {
    this.resolveTurn?.({ text: "", cancelled: true, agentInvoked: true });
  });
  readonly steer = vi.fn(async () => undefined);
  state: OmpSessionState = {
    sessionId: "omp-session-1",
    sessionFile: "/synthetic/omp-session.jsonl",
    provider: "synthetic",
    modelId: "model",
    thinkingLevel: harnessThinkingOptionIdSchema.parse("high"),
    contextUsage: null,
    availableThinkingLevels: [harnessThinkingOptionIdSchema.parse("high")],
  };
  history: OmpSessionHistory = { entries: [], leafId: null };
  onEvent: ((event: OmpTurnEvent) => void) | null = null;
  resolveTurn: ((result: OmpTurnResult) => void) | null = null;

  async start(): Promise<void> {}
  async getAvailableModels() {
    return [{ provider: "synthetic", id: "model", reasoning: true }];
  }
  async getAvailableThinkingLevels() {
    return [harnessThinkingOptionIdSchema.parse("high")];
  }
  async getEntries(): Promise<OmpSessionHistory> {
    return this.history;
  }
  async getSubagentMessages() {
    return {
      sessionFile: "/synthetic/subagent.jsonl",
      fromByte: 0,
      nextByte: 0,
      reset: false,
      entries: [],
      messages: [],
    };
  }
  async getSessionUsage() {
    return null;
  }
  async fork() {
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
  runTurn(_text: string, onEvent: (event: OmpTurnEvent) => void): Promise<OmpTurnResult> {
    this.onEvent = onEvent;
    onEvent({
      type: "tool.started",
      callId: "call-1",
      toolName: "bash",
      arguments: { command: "echo hello" },
    });
    return new Promise((resolve) => {
      this.resolveTurn = (result) => {
        onEvent({
          type: "tool.completed",
          callId: "call-1",
          toolName: "bash",
          result: "hello",
          isError: false,
        });
        resolve(result);
      };
    });
  }
  async respondToInteraction(): Promise<void> {}
  async close(): Promise<void> {}
}

function openAdapter() {
  const transports: SteerOmpTransport[] = [];
  const adapter = new OmpAdapter(
    {},
    {
      createTransport: () => {
        const transport = new SteerOmpTransport();
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

function historyOf(userTexts: string[]): OmpSessionHistory {
  let parentId: string | null = null;
  const entries: OmpSessionHistory["entries"] = [];
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

describe("Omp steer capability", () => {
  it("declares steer on the session and on inspect", async () => {
    const opened = await openSession();
    expect(opened.session.capabilities.steer).toBe(false);
    const inspected = await opened.adapter.inspect({ cwd: "/synthetic", refresh: true });
    expect(inspected.status === "ready" ? inspected.capabilities.steer : false).toBeUndefined();
    const turnId = hostTurnIdSchema.parse("capability-turn");
    await opened.session.execute({
      type: "turn.start",
      turnId,
      input: [{ type: "text", text: "run" }],
    });
    expect(opened.session.capabilities.steer).toBe(true);
    opened.transports[0]?.resolveTurn?.({ text: "done", cancelled: true, agentInvoked: true });
  });
});

describe("Omp turn.steer", () => {
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
    expect(transport.steer).toHaveBeenCalledWith("line one\nline two");
    expect(transport.abort).not.toHaveBeenCalled();
    expect(userMessageEvents(outputs)).toEqual([]);

    await expect(
      session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("turn-2"),
        input: [{ type: "text", text: "another" }],
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "sessionBusy" } });

    transport.history = historyOf(["run the tool", "line one\nline two"]);
    transport.resolveTurn?.({ text: "pong", cancelled: false, agentInvoked: true });
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

  it("preserves acceptance when the Turn finishes before the steer receipt", async () => {
    const { session, transports, outputs } = await openSession();
    const turnId = await startTurn(session);
    const transport = transports[0];
    if (!transport) throw new Error("Missing transport");
    const receipt = Promise.withResolvers<undefined>();
    transport.steer.mockImplementationOnce(() => receipt.promise);
    const steering = session.execute({
      type: "turn.steer",
      turnId,
      input: [{ type: "text", text: "reply pong" }],
    });
    transport.history = historyOf(["run the tool", "reply pong"]);
    transport.resolveTurn?.({ text: "pong", cancelled: false, agentInvoked: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(
      session.execute({
        type: "turn.steer",
        turnId,
        input: [{ type: "text", text: "too late" }],
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidState" } });
    receipt.resolve(undefined);
    await expect(steering).resolves.toEqual({ ok: true, value: { accepted: true } });
    await vi.waitFor(() =>
      expect(hostEvents(outputs).find((event) => event.type === "turn.completed")).toMatchObject({
        turnId,
        nativeTurnRef: { nativeTurnKey: "user-1" },
        outcome: { status: "succeeded" },
      }),
    );
    expect(transport.steer).toHaveBeenCalledOnce();
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
    transport.history = historyOf(["run the tool", "reply pong", "other client"]);
    transport.resolveTurn?.({ text: "pong", cancelled: false, agentInvoked: true });
    await vi.waitFor(() => {
      expect(hostEvents(outputs).some((event) => event.type === "turn.completed")).toBe(true);
    });
    expect(hostEvents(outputs).find((event) => event.type === "turn.completed")).toMatchObject({
      outcome: {
        status: "failed",
        error: { code: "protocolError", message: expect.stringContaining("exactly 2 is required") },
      },
    });
  });

  it("stops offering steer when the last root tool ends", async () => {
    const { session, transports } = await openSession();
    const turnId = await startTurn(session);
    const transport = transports[0];
    if (!transport) throw new Error("Missing transport");
    transport.onEvent?.({
      type: "tool.completed",
      callId: "call-1",
      toolName: "bash",
      result: "done",
      isError: false,
    });
    expect(session.capabilities.steer).toBe(false);
    await expect(
      session.execute({ type: "turn.steer", turnId, input: [{ type: "text", text: "late" }] }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidState" } });
    expect(transport.steer).not.toHaveBeenCalled();
  });

  it("rejects new input while cancellation is pending", async () => {
    const { session, transports } = await openSession();
    const turnId = await startTurn(session);
    const transport = transports[0];
    if (!transport) throw new Error("Missing transport");
    transport.abort.mockImplementationOnce(async () => undefined);
    await session.execute({ type: "turn.cancel", turnId });
    expect(session.capabilities.steer).toBe(false);
    await expect(
      session.execute({ type: "turn.steer", turnId, input: [{ type: "text", text: "late" }] }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidState" } });
    expect(transport.steer).not.toHaveBeenCalled();
  });

  it("does not turn a lost native receipt into a safe-to-resend refusal", async () => {
    const { session, transports } = await openSession();
    const turnId = await startTurn(session);
    const transport = transports[0];
    if (!transport) throw new Error("Missing transport");
    transport.steer.mockRejectedValueOnce(new Error("steer receipt timed out"));
    await expect(
      session.execute({ type: "turn.steer", turnId, input: [{ type: "text", text: "once" }] }),
    ).rejects.toThrow("steer receipt timed out");
    expect(transport.steer).toHaveBeenCalledOnce();
    expect(transport.abort).not.toHaveBeenCalled();
  });

  it("rejects an inactive turn, an empty steer, a native rejection, and a closed session", async () => {
    const { session, transports } = await openSession();
    const turnId = await startTurn(session);
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
    expect(transports[0]?.steer).not.toHaveBeenCalled();
    transports[0]?.steer.mockRejectedValueOnce(
      new OmpRpcSteerRejectedError("Omp RPC steer was not accepted"),
    );
    await expect(
      session.execute({
        type: "turn.steer",
        turnId,
        input: [{ type: "text", text: "reply pong" }],
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "invalidState", message: "Omp RPC steer was not accepted" },
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

describe("Omp RPC steer", () => {
  it.each(["missing", "handled"])(
    "does not classify a %s native receipt as rejection",
    async (receipt) => {
      const fake = new FakeOmpProcess();
      fake.steerReceipt = receipt;
      const rpc = new OmpRpcSession(
        { cwd: process.cwd(), commandTimeoutMs: 50, closeTimeoutMs: 500 },
        { spawn: () => fake as unknown as ChildProcessWithoutNullStreams },
      );
      await rpc.start();
      const failure = await rpc.steer("once").catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(OmpRpcSteerRejectedError);
      expect(fake.steered).toEqual(["once"]);
      await rpc.close();
    },
  );

  it("marks only an explicit native rejection as not accepted", async () => {
    const fake = new FakeOmpProcess();
    fake.rejectSteer = "Agent is idle";
    const rpc = new OmpRpcSession(
      { cwd: process.cwd(), commandTimeoutMs: 2_000, closeTimeoutMs: 500 },
      { spawn: () => fake as unknown as ChildProcessWithoutNullStreams },
    );
    await rpc.start();
    await expect(rpc.steer("reply pong")).rejects.toBeInstanceOf(OmpRpcSteerRejectedError);
    await rpc.close();
  });

  it("sends steer and ignores the user echo", async () => {
    const fake = new FakeOmpProcess();
    const processAdapter: OmpRpcProcessAdapter = {
      spawn: () => fake as unknown as ChildProcessWithoutNullStreams,
    };
    const rpc = new OmpRpcSession(
      { cwd: process.cwd(), commandTimeoutMs: 2_000, closeTimeoutMs: 500 },
      processAdapter,
    );
    const events: OmpTurnEvent[] = [];
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
});

class FakeOmpProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 42_002;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly steered: string[] = [];
  rejectSteer: string | null = null;
  steerReceipt = "queued";
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
    queueMicrotask(() => {
      this.emit("spawn");
      this.#output({ type: "ready" });
    });
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
      if (this.steerReceipt === "missing") return;
      if (this.steerReceipt === "handled") {
        this.#respond(command, { disposition: "handled" });
        return;
      }
      this.#respond(command);
      const user = {
        role: "user",
        steering: true,
        content: [{ type: "text", text: "reply pong" }],
      };
      const assistant = {
        role: "assistant",
        content: [{ type: "text", text: "pong" }],
        stopReason: "stop",
      };
      this.#output({ type: "message_start", message: user });
      this.#output({ type: "message_end", message: user });
      this.#output({ type: "message_end", message: assistant });
      this.#output({ type: "agent_end", isTerminal: true, messages: [assistant] });
      return;
    }
    this.#respond(command, {
      sessionId: "omp-session",
      sessionFile: null,
      model: { provider: "synthetic", id: "model", thinking: { efforts: ["high"] } },
      thinkingLevel: "high",
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
