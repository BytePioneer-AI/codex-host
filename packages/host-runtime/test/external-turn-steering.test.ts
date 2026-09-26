import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  HarnessResult,
  TurnCancelAccepted,
  TurnCancelCommand,
} from "@codexhost/harness-adapter";

import { hostTurnIdSchema } from "@codexhost/shared-contracts";

import { ExternalTurnSteering } from "../src/external-turn-steering.js";

type Cancel = (command: TurnCancelCommand) => Promise<HarnessResult<TurnCancelAccepted>>;

function fixture() {
  const coordinator = new ExternalTurnSteering(50);
  const execute = vi
    .fn<Cancel>()
    .mockResolvedValue({ ok: true, value: { cancellationRequested: true } });
  const thread = {
    id: "thread",
    running: true,
    activeTurnId: hostTurnIdSchema.parse("old") as ReturnType<typeof hostTurnIdSchema.parse> | null,
    persistenceError: null as Error | null,
    session: { capabilities: {} as { steer?: boolean }, execute },
  };
  const started = {
    turnId: hostTurnIdSchema.parse("new"),
    gate: { promise: Promise.resolve(), resolve: vi.fn() },
  };
  const start = vi
    .fn<(text: string, assertActive: () => void) => Promise<typeof started>>()
    .mockResolvedValue(started);
  const replaced = { ...started, delivery: "newTurn" };
  const insert = vi
    .fn<
      (input: {
        turnId: ReturnType<typeof hostTurnIdSchema.parse>;
        text: string;
        clientUserMessageId?: string;
      }) => Promise<typeof started>
    >()
    .mockImplementation(async ({ turnId }) => ({ ...started, turnId }));
  const params = {
    threadId: "thread",
    expectedTurnId: "old",
    clientUserMessageId: "message",
    input: [{ type: "text", text: "new input" }],
  };
  const complete = () => {
    thread.running = false;
    thread.activeTurnId = null;
    coordinator.terminal("thread", "old", { status: "cancelled" });
  };
  return { coordinator, execute, thread, start, started, replaced, insert, params, complete };
}

afterEach(() => vi.useRealTimers());

describe("Host stop-then-start coordination", () => {
  it("waits for terminal projection, not cancel acknowledgement, and coalesces delivery retries", async () => {
    const f = fixture();
    const first = f.coordinator.run(f.thread, f.params, f.start, f.insert);
    const duplicate = f.coordinator.run(f.thread, f.params, f.start, f.insert);
    await Promise.resolve();
    expect(f.coordinator.hasPending("thread")).toBe(true);
    expect(f.start).not.toHaveBeenCalled();
    f.coordinator.terminal("thread", "other", { status: "cancelled" });
    await Promise.resolve();
    expect(f.start).not.toHaveBeenCalled();
    f.complete();
    await expect(first).resolves.toEqual(f.replaced);
    await expect(duplicate).resolves.toEqual(f.replaced);
    await expect(f.coordinator.run(f.thread, f.params, f.start, f.insert)).resolves.toEqual(
      f.replaced,
    );
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.start).toHaveBeenCalledExactlyOnceWith("new input", expect.any(Function));
    expect(f.coordinator.hasPending()).toBe(false);
  });

  it("also waits for acknowledgement when the old terminal arrives first", async () => {
    const f = fixture();
    const ack = Promise.withResolvers<Awaited<ReturnType<Cancel>>>();
    f.execute.mockReturnValue(ack.promise);
    const result = f.coordinator.run(f.thread, f.params, f.start, f.insert);
    f.complete();
    await Promise.resolve();
    expect(f.start).not.toHaveBeenCalled();
    ack.resolve({ ok: true, value: { cancellationRequested: true } });
    await expect(result).resolves.toEqual(f.replaced);
  });

  it("registers the waiter before synchronous cancellation completion", async () => {
    const f = fixture();
    f.execute.mockImplementation(async () => {
      f.complete();
      return { ok: true, value: { cancellationRequested: true } };
    });
    await expect(f.coordinator.run(f.thread, f.params, f.start, f.insert)).resolves.toEqual(
      f.replaced,
    );
  });

  it("rejects stale identities and invalid input without stopping anything", async () => {
    const f = fixture();
    await expect(
      f.coordinator.run(f.thread, { ...f.params, expectedTurnId: "wrong" }, f.start, f.insert),
    ).rejects.toMatchObject({ code: -32074 });
    for (const input of [
      [],
      [{ type: "text", text: " " }],
      [
        { type: "text", text: "valid" },
        { type: "image", url: "x" },
      ],
    ]) {
      await expect(
        f.coordinator.run(f.thread, { ...f.params, input }, f.start, f.insert),
      ).rejects.toMatchObject({ code: -32602 });
    }
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("rejects concurrent replacements and conflicting message-id reuse", async () => {
    const f = fixture();
    const first = f.coordinator.run(f.thread, f.params, f.start, f.insert);
    await expect(
      f.coordinator.run(f.thread, { ...f.params, clientUserMessageId: "other" }, f.start, f.insert),
    ).rejects.toMatchObject({ code: -32072 });
    await expect(
      f.coordinator.run(
        f.thread,
        { ...f.params, input: [{ type: "text", text: "different" }] },
        f.start,
        f.insert,
      ),
    ).rejects.toMatchObject({ code: -32602 });
    f.complete();
    await first;
  });

  it.each(["acknowledgement", "terminal"])(
    "never starts after timing out on %s, even if it arrives later",
    async (waitingFor) => {
      vi.useFakeTimers();
      const f = fixture();
      const ack = Promise.withResolvers<Awaited<ReturnType<Cancel>>>();
      if (waitingFor === "acknowledgement") f.execute.mockReturnValue(ack.promise);
      const result = f.coordinator.run(f.thread, f.params, f.start, f.insert);
      const rejected = expect(result).rejects.toThrow("Timed out");
      await vi.advanceTimersByTimeAsync(50);
      await rejected;
      f.complete();
      ack.resolve({ ok: true, value: { cancellationRequested: true } });
      await Promise.resolve();
      expect(f.start).not.toHaveBeenCalled();
      expect(f.coordinator.hasPending()).toBe(false);
    },
  );

  it.each(["close", "fault", "failed", "persistence", "autonomous", "interrupt"])(
    "does not replace after %s",
    async (reason) => {
      const f = fixture();
      const result = f.coordinator.run(f.thread, f.params, f.start, f.insert);
      const rejected = expect(result).rejects.toBeInstanceOf(Error);
      if (reason === "close") f.coordinator.close();
      else if (reason === "interrupt") f.coordinator.interrupt("thread", "old");
      else if (reason === "fault") f.coordinator.fault("thread", new Error("session fault"));
      else if (reason === "failed") {
        f.coordinator.terminal("thread", "old", {
          status: "failed",
          error: { code: "nativeFailure", message: "cancel failed", retryable: false },
        });
      } else {
        f.complete();
        if (reason === "persistence") f.thread.persistenceError = new Error("disk failure");
        else {
          f.thread.activeTurnId = hostTurnIdSchema.parse("autonomous");
          f.thread.running = true;
        }
      }
      await rejected;
      expect(f.start).not.toHaveBeenCalled();
    },
  );

  it.each(["interrupt", "fault"])(
    "honors %s after terminal resolution but before replacement admission",
    async (reason) => {
      const f = fixture();
      const result = f.coordinator.run(f.thread, f.params, f.start, f.insert);
      f.complete();
      if (reason === "interrupt") f.coordinator.interrupt("thread", "old");
      else f.coordinator.fault("thread", new Error("late fault"));
      await expect(result).rejects.toBeInstanceOf(Error);
      expect(f.start).not.toHaveBeenCalled();
    },
  );

  it.each(["interrupt", "close", "fault"])(
    "rechecks %s after asynchronous replacement preparation",
    async (reason) => {
      const f = fixture();
      const preparing = Promise.withResolvers<undefined>();
      const prepared = Promise.withResolvers<undefined>();
      f.start.mockImplementation(async (_text, assertActive) => {
        preparing.resolve(undefined);
        await prepared.promise;
        assertActive();
        return f.started;
      });
      const result = f.coordinator.run(f.thread, f.params, f.start, f.insert);
      f.complete();
      await preparing.promise;
      if (reason === "interrupt") f.coordinator.interrupt("thread", "old");
      else if (reason === "close") f.coordinator.close();
      else f.coordinator.fault("thread", new Error("preparation fault"));
      prepared.resolve(undefined);
      await expect(result).rejects.toBeInstanceOf(Error);
      expect(f.coordinator.hasPending()).toBe(false);
    },
  );

  it("propagates cancellation rejection and new-start failure without retrying", async () => {
    const f = fixture();
    f.execute.mockResolvedValueOnce({
      ok: false,
      error: { code: "nativeFailure", message: "stop rejected", retryable: false },
    });
    await expect(f.coordinator.run(f.thread, f.params, f.start, f.insert)).rejects.toThrow(
      "stop rejected",
    );
    expect(f.start).not.toHaveBeenCalled();
    const result = f.coordinator.run(f.thread, f.params, f.start, f.insert);
    f.start.mockRejectedValueOnce(new Error("start rejected"));
    f.complete();
    await expect(result).rejects.toThrow("start rejected");
    expect(f.start).toHaveBeenCalledOnce();
  });
});

describe("Host native steering", () => {
  it("takes input into the active Turn without cancelling, once per message identity", async () => {
    const f = fixture();
    f.thread.session.capabilities.steer = true;
    const first = f.coordinator.run(f.thread, f.params, f.start, f.insert);
    const duplicate = f.coordinator.run(f.thread, f.params, f.start, f.insert);
    await expect(first).resolves.toEqual({ ...f.started, turnId: "old", delivery: "activeTurn" });
    await expect(duplicate).resolves.toEqual({
      ...f.started,
      turnId: "old",
      delivery: "activeTurn",
    });
    expect(f.insert).toHaveBeenCalledExactlyOnceWith({
      turnId: "old",
      text: "new input",
      clientUserMessageId: "message",
    });
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
    expect(f.coordinator.hasPending()).toBe(false);
  });

  it("keeps the active-Turn check and releases a failed message identity for retry", async () => {
    const f = fixture();
    f.thread.session.capabilities.steer = true;
    await expect(
      f.coordinator.run(f.thread, { ...f.params, expectedTurnId: "stale" }, f.start, f.insert),
    ).rejects.toMatchObject({ code: -32074 });
    f.insert.mockRejectedValueOnce(new Error("native rejected"));
    await expect(f.coordinator.run(f.thread, f.params, f.start, f.insert)).rejects.toThrow(
      "native rejected",
    );
    await expect(f.coordinator.run(f.thread, f.params, f.start, f.insert)).resolves.toMatchObject({
      delivery: "activeTurn",
    });
    expect(f.insert).toHaveBeenCalledTimes(2);
  });
});
