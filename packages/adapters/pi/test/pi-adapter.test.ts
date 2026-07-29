import { describe, expect, it, vi } from "vitest";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";

import type { HarnessOutput, HarnessSession } from "@codexhost/harness-adapter";
import { PiAdapter, type PiAdapterDependencies, type PiTextTransport } from "../src/pi-adapter.js";
import {
  PiRpcFaultError,
  type PiRpcSessionOptions,
  type PiSessionState,
} from "../src/pi-rpc-session.js";

class FakePiTransport implements PiTextTransport {
  readonly state: PiSessionState = {
    sessionId: "pi-session-1",
    sessionFile: "/synthetic/pi-session.jsonl",
    provider: "synthetic-provider",
    modelId: "synthetic-model",
  };
  readonly close = vi.fn(async () => undefined);
  readonly start = vi.fn(async () => undefined);
  readonly runTextTurn = vi.fn((text: string, onDelta: (delta: string) => void) => {
    this.text = text;
    this.onDelta = onDelta;
    return new Promise<{ text: string }>((resolve, reject) => {
      this.resolveTurn = resolve;
      this.rejectTurn = reject;
    });
  });
  onDelta: ((delta: string) => void) | null = null;
  options: PiRpcSessionOptions | null = null;
  rejectTurn: ((error: Error) => void) | null = null;
  resolveTurn: ((value: { text: string }) => void) | null = null;
  text: string | null = null;

  delta(text: string): void {
    if (!this.onDelta) throw new Error("No active fake Pi Turn");
    this.onDelta(text);
  }

  succeed(text: string): void {
    if (!this.resolveTurn) throw new Error("No active fake Pi Turn");
    this.resolveTurn({ text });
    this.resetTurn();
  }

  fail(error: Error): void {
    if (!this.rejectTurn) throw new Error("No active fake Pi Turn");
    this.rejectTurn(error);
    this.resetTurn();
  }

  fault(error: PiRpcFaultError): void {
    this.fail(error);
    this.options?.onFault?.(error);
  }

  private resetTurn(): void {
    this.onDelta = null;
    this.rejectTurn = null;
    this.resolveTurn = null;
  }
}

function fixture() {
  const transports: FakePiTransport[] = [];
  const dependencies: PiAdapterDependencies = {
    createTransport: vi.fn((options) => {
      const transport = new FakePiTransport();
      transport.options = options;
      transports.push(transport);
      return transport;
    }),
  };
  const adapter = new PiAdapter({}, dependencies);
  return { adapter, dependencies, transports };
}

async function openSession(adapter: PiAdapter): Promise<HarnessSession> {
  const result = await adapter.open({ kind: "create", cwd: "/synthetic" });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function textTurn(id: string) {
  return {
    type: "turn.start" as const,
    turnId: hostTurnIdSchema.parse(id),
    input: [{ type: "text" as const, text: id }],
  };
}

async function nextEvent(iterator: AsyncIterator<HarnessOutput>) {
  const result = await iterator.next();
  if (result.done) throw new Error("Harness output stream ended unexpectedly");
  return result.value.event;
}

describe("Pi HarnessAdapter text Session", () => {
  it("starts lazily and emits an ordered successful text lifecycle", async () => {
    const { adapter, dependencies, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    expect(dependencies.createTransport).not.toHaveBeenCalled();
    await expect(session.execute(textTurn("turn-1"))).resolves.toEqual({
      ok: true,
      value: { turnId: "turn-1" },
    });
    const transport = transports[0];
    expect(transport?.start).toHaveBeenCalledOnce();
    expect((await nextEvent(iterator)).type).toBe("session.state.changed");
    expect((await nextEvent(iterator)).type).toBe("turn.started");
    expect((await nextEvent(iterator)).type).toBe("item.started");

    transport?.delta("hello");
    transport?.delta(" world");
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "text.append", text: "hello" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "text.append", text: " world" },
    });
    transport?.succeed("hello world");
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { text: "hello world" }, outcome: { status: "succeeded" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });

    await session.close();
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("rejects startup before Turn acceptance without lifecycle events", async () => {
    const { adapter, dependencies, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    vi.mocked(dependencies.createTransport).mockImplementationOnce((options) => {
      const transport = new FakePiTransport();
      transport.options = options;
      transport.start.mockRejectedValueOnce(new Error("synthetic startup failure"));
      transports.push(transport);
      return transport;
    });

    const result = await session.execute(textTurn("rejected"));
    expect(result).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect((await nextEvent(iterator)).type).toBe("session.faulted");
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("completes an accepted failed Turn and remains reusable", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    await session.execute(textTurn("turn-1"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);

    transports[0]?.fail(new Error("synthetic Turn failure"));
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { outcome: { status: "failed" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "failed" },
    });

    await expect(session.execute(textTurn("turn-2"))).resolves.toMatchObject({ ok: true });
    expect(transports[0]?.start).toHaveBeenCalledOnce();
    transports[0]?.succeed("second");
    await session.close();
  });

  it("rejects a concurrent Turn", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);

    await session.execute(textTurn("active"));
    await expect(session.execute(textTurn("second"))).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });
    transports[0]?.succeed("done");
    await session.close();
  });

  it("atomically reserves a Turn while the transport is starting", async () => {
    const { adapter, dependencies, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    let releaseStart!: () => void;
    const startGate = new Promise<undefined>((resolve) => {
      releaseStart = () => resolve(undefined);
    });
    vi.mocked(dependencies.createTransport).mockImplementationOnce((options) => {
      const transport = new FakePiTransport();
      transport.options = options;
      transport.start.mockImplementationOnce(() => startGate);
      transports.push(transport);
      return transport;
    });

    const first = session.execute(textTurn("first"));
    const second = session.execute(textTurn("second"));
    releaseStart();

    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(second).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });
    expect((await nextEvent(iterator)).type).toBe("session.state.changed");
    expect(await nextEvent(iterator)).toMatchObject({ type: "turn.started", turnId: "first" });
    expect(await nextEvent(iterator)).toMatchObject({ type: "item.started", turnId: "first" });

    transports[0]?.succeed("done");
    expect(await nextEvent(iterator)).toMatchObject({ type: "item.completed", turnId: "first" });
    expect(await nextEvent(iterator)).toMatchObject({ type: "turn.completed", turnId: "first" });
    await session.close();
  });

  it("finishes the active lifecycle before faulting the Session", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    await session.execute(textTurn("faulted"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);

    transports[0]?.fault(new PiRpcFaultError("processExited", "synthetic process exit"));
    expect((await nextEvent(iterator)).type).toBe("item.completed");
    expect((await nextEvent(iterator)).type).toBe("turn.completed");
    expect((await nextEvent(iterator)).type).toBe("session.faulted");
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("does not create a transport for unused prewarm and closes idempotently", async () => {
    const { adapter, dependencies } = fixture();
    const session = await openSession(adapter);

    await expect(Promise.all([session.close(), session.close()])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(dependencies.createTransport).not.toHaveBeenCalled();
    await expect(Promise.all([adapter.close(), adapter.close()])).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });
});
