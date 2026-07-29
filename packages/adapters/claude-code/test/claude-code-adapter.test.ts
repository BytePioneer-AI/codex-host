import { describe, expect, it, vi } from "vitest";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";

import type { HarnessOutput, HarnessSession } from "@codexhost/harness-adapter";
import {
  ClaudeCodeAdapter,
  ClaudeCodeExecutableError,
  type ClaudeAdapterDependencies,
  type ClaudeTransportTurnResult,
  type ClaudeTurnTransport,
} from "../src/index.js";

class FakeClaudeTransport implements ClaudeTurnTransport {
  readonly sessionId: string;
  readonly abort = vi.fn(async () => undefined);
  readonly close = vi.fn(async () => undefined);
  readonly start = vi.fn(async () => undefined);
  readonly turns: Array<{ text: string; userMessageId: string }> = [];
  #active:
    | {
        onTextDelta(delta: string): void;
        resolve(result: ClaudeTransportTurnResult): void;
        reject(error: unknown): void;
      }
    | undefined;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  runTurn(
    text: string,
    userMessageId: string,
    onTextDelta: (delta: string) => void,
  ): Promise<ClaudeTransportTurnResult> {
    this.turns.push({ text, userMessageId });
    return new Promise((resolve, reject) => {
      this.#active = { onTextDelta, resolve, reject };
    });
  }

  delta(text: string): void {
    this.#active?.onTextDelta(text);
  }

  finish(result: ClaudeTransportTurnResult): void {
    this.#active?.resolve(result);
    this.#active = undefined;
  }

  fault(error: unknown): void {
    this.#active?.reject(error);
    this.#active = undefined;
  }
}

function fixture() {
  const transports: FakeClaudeTransport[] = [];
  let uuid = 0;
  const dependencies: ClaudeAdapterDependencies = {
    randomUUID: () => `claude-id-${++uuid}`,
    createTransport: vi.fn((input) => {
      const transport = new FakeClaudeTransport(input.sessionId);
      transports.push(transport);
      return transport;
    }),
  };
  const adapter = new ClaudeCodeAdapter({ closeTimeoutMs: 50 }, dependencies);
  return { adapter, dependencies, transports };
}

async function openSession(adapter: ClaudeCodeAdapter): Promise<HarnessSession> {
  const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
  if (!opened.ok) throw new Error(opened.error.message);
  return opened.value;
}

function textTurn(id: string) {
  return {
    type: "turn.start" as const,
    turnId: hostTurnIdSchema.parse(id),
    input: [{ type: "text" as const, text: id }],
  };
}

async function nextEvent(iterator: AsyncIterator<HarnessOutput>) {
  const output = await iterator.next();
  if (output.done) throw new Error("Harness output ended unexpectedly");
  if (output.value.kind !== "event") throw new Error("Expected a Harness event output");
  return output.value.event;
}

describe("Claude Code HarnessAdapter", () => {
  it("opens and closes unused Sessions without creating a Transport", async () => {
    const { adapter, dependencies } = fixture();
    const session = await openSession(adapter);

    expect(dependencies.createTransport).not.toHaveBeenCalled();
    await session.close();
    expect(dependencies.createTransport).not.toHaveBeenCalled();
  });

  it("starts lazily and emits a complete text lifecycle", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await expect(session.execute(textTurn("turn-1"))).resolves.toEqual({
      ok: true,
      value: { turnId: "turn-1" },
    });
    expect(transports[0]?.start).toHaveBeenCalledOnce();
    expect((await nextEvent(iterator)).type).toBe("session.state.changed");
    expect((await nextEvent(iterator)).type).toBe("turn.started");
    expect((await nextEvent(iterator)).type).toBe("item.started");
    transports[0]?.delta("hello");
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "text.append", text: "hello" },
    });
    transports[0]?.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { text: "hello" }, outcome: { status: "succeeded" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    await session.close();
  });

  it("reuses one Transport and Native Session for sequential Turns", async () => {
    const { adapter, dependencies, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("turn-1"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);

    await session.execute(textTurn("turn-2"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);

    expect(dependencies.createTransport).toHaveBeenCalledOnce();
    expect(transports[0]?.start).toHaveBeenCalledOnce();
    expect(transports[0]?.turns.map(({ text }) => text)).toEqual(["turn-1", "turn-2"]);
    expect(new Set(transports[0]?.turns.map(({ userMessageId }) => userMessageId)).size).toBe(2);
    await session.close();
  });

  it("rejects a concurrent Turn without disturbing the active Turn", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);

    await session.execute(textTurn("turn-1"));
    await expect(session.execute(textTurn("turn-2"))).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });
    transports[0]?.finish({ status: "succeeded" });
    await session.close();
  });

  it("maps proven cancellation and continues on the same Transport", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("cancelled"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const cancel = {
      type: "turn.cancel" as const,
      turnId: hostTurnIdSchema.parse("cancelled"),
    };
    await expect(session.execute(cancel)).resolves.toEqual({
      ok: true,
      value: { cancellationRequested: true },
    });
    await expect(session.execute(cancel)).resolves.toEqual({
      ok: true,
      value: { cancellationRequested: true },
    });
    expect(transports[0]?.abort).toHaveBeenCalledOnce();
    transports[0]?.finish({ status: "cancelled", reason: "aborted_streaming" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { outcome: { status: "cancelled" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "cancelled" },
    });

    await expect(session.execute(textTurn("continued"))).resolves.toMatchObject({ ok: true });
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);
    expect(transports).toHaveLength(1);
    await session.close();
  });

  it("maps failed native results without faulting a reusable Session", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("failed"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.finish({ status: "failed", kind: "authentication" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { outcome: { status: "failed", error: { code: "authenticationRequired" } } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "failed", error: { code: "authenticationRequired" } },
    });
    await expect(session.execute(textTurn("retry"))).resolves.toMatchObject({ ok: true });
    transports[0]?.finish({ status: "succeeded" });
    await session.close();
  });

  it("finalizes an active Turn before a Query fault", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("faulted"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.fault(new Error("synthetic Query fault"));

    expect((await nextEvent(iterator)).type).toBe("item.completed");
    expect((await nextEvent(iterator)).type).toBe("turn.completed");
    expect(await nextEvent(iterator)).toMatchObject({
      type: "session.faulted",
      error: { code: "processExited" },
    });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("rejects missing installation before acceptance without outputs", async () => {
    const dependencies: ClaudeAdapterDependencies = {
      randomUUID: () => "claude-id",
      createTransport: () => ({
        sessionId: "claude-id",
        start: async () => {
          throw new ClaudeCodeExecutableError("Claude Code is not installed");
        },
        runTurn: async () => ({ status: "succeeded" }),
        abort: async () => undefined,
        close: async () => undefined,
      }),
    };
    const adapter = new ClaudeCodeAdapter({}, dependencies);
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await expect(session.execute(textTurn("missing"))).resolves.toMatchObject({
      ok: false,
      error: { code: "notInstalled" },
    });
    await session.close();
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("closes all Sessions idempotently", async () => {
    const { adapter } = fixture();
    await openSession(adapter);
    await openSession(adapter);

    await expect(Promise.all([adapter.close(), adapter.close()])).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });
});
