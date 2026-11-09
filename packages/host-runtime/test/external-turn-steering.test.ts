import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  HarnessResult,
  HarnessSession,
  TurnCancelAccepted,
  TurnCancelCommand,
} from "@codexhost/harness-adapter";

import { FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import { harnessIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";

import {
  ExternalSteerNotTakenError,
  ExternalTurnSteering,
  externalSteeringDelivery,
} from "../src/external-turn-steering.js";

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
  it("preserves local image references when steering must stop and restart", async () => {
    const f = fixture();
    const input = [...f.params.input, { type: "localImage", path: "C:\\images\\second.png" }];
    const result = f.coordinator.run(f.thread, { ...f.params, input }, f.start, f.insert);
    await Promise.resolve();
    f.complete();
    await expect(result).resolves.toEqual(f.replaced);
    expect(f.start).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("C:\\images\\second.png\nImage attachment: true"),
      expect.any(Function),
    );
    expect(f.insert).not.toHaveBeenCalled();
  });

  it("deduplicates image steers using the original input, not only its text", async () => {
    const f = fixture();
    f.thread.session.capabilities.steer = true;
    const params = {
      ...f.params,
      input: [...f.params.input, { type: "localImage", path: "/tmp/one.png" }],
    };
    await f.coordinator.run(f.thread, params, f.start, f.insert);
    await f.coordinator.run(f.thread, params, f.start, f.insert);
    expect(f.insert).toHaveBeenCalledOnce();
    await expect(
      f.coordinator.run(
        f.thread,
        { ...params, input: [...f.params.input, { type: "localImage", path: "/tmp/two.png" }] },
        f.start,
        f.insert,
      ),
    ).rejects.toMatchObject({ code: -32602 });
    expect(f.insert).toHaveBeenCalledOnce();
    expect(f.execute).not.toHaveBeenCalled();
  });

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
      [{ type: "localImage", path: "relative.png" }],
      [
        { type: "text", text: "/compact" },
        { type: "localImage", path: "/tmp/image.png" },
      ],
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
  it("starts the next Turn when untaken input arrives after the active Turn ended", async () => {
    const f = fixture();
    f.thread.session.capabilities.steer = true;
    f.insert.mockImplementationOnce(async () => {
      f.thread.running = false;
      f.thread.activeTurnId = null;
      throw new ExternalSteerNotTakenError("Turn ended first");
    });
    await expect(f.coordinator.run(f.thread, f.params, f.start, f.insert)).resolves.toEqual(
      f.replaced,
    );
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.start).toHaveBeenCalledOnce();
  });

  it("does not cancel a different Turn when native refusal arrives late", async () => {
    const f = fixture();
    f.thread.session.capabilities.steer = true;
    f.insert.mockImplementationOnce(async () => {
      f.thread.activeTurnId = hostTurnIdSchema.parse("autonomous");
      throw new ExternalSteerNotTakenError("requested Turn ended");
    });
    await expect(f.coordinator.run(f.thread, f.params, f.start, f.insert)).rejects.toMatchObject({
      code: -32074,
    });
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  });

  it("waits for an ending Turn whose cancel is refused as inactive", async () => {
    const f = fixture();
    f.thread.session.capabilities.steer = true;
    f.insert.mockRejectedValueOnce(new ExternalSteerNotTakenError("no tool running"));
    f.execute.mockResolvedValueOnce({
      ok: false,
      error: { code: "invalidState", message: "Turn is not active", retryable: false },
    });
    const result = f.coordinator.run(f.thread, f.params, f.start, f.insert);
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
    f.complete();
    await expect(result).resolves.toEqual(f.replaced);
  });

  it("reads remote capabilities without trusting the open-time snapshot", async () => {
    const f = fixture();
    const capabilities = {
      ...new FakeHarnessSession(harnessIdSchema.parse("pi")).capabilities,
      steer: true,
    };
    const readCapabilities = vi.fn(async () => capabilities);
    const thread = { ...f.thread, session: { ...f.thread.session, readCapabilities } };
    await expect(externalSteeringDelivery(thread)).resolves.toBe("activeTurn");
    await expect(f.coordinator.run(thread, f.params, f.start, f.insert)).resolves.toMatchObject({
      delivery: "activeTurn",
    });
    expect(readCapabilities).toHaveBeenCalledTimes(2);
    expect(f.execute).not.toHaveBeenCalled();
    capabilities.steer = false;
    await expect(externalSteeringDelivery(thread)).resolves.toBe("newTurn");
  });

  it.each(["ended", "changed", "closed", "failed", "interrupt", "fault"])(
    "does not deliver after capability read %s",
    async (reason) => {
      const f = fixture();
      const read =
        Promise.withResolvers<
          Awaited<ReturnType<NonNullable<HarnessSession["readCapabilities"]>>>
        >();
      const thread = Object.assign(f.thread, {
        session: { ...f.thread.session, readCapabilities: () => read.promise },
      });
      const result = f.coordinator.run(thread, f.params, f.start, f.insert);
      const rejected = expect(result).rejects.toBeInstanceOf(Error);
      if (reason === "ended") f.complete();
      if (reason === "changed") f.thread.activeTurnId = hostTurnIdSchema.parse("other");
      if (reason === "closed") f.coordinator.close();
      if (reason === "interrupt") f.coordinator.interrupt("thread", "old");
      if (reason === "fault") f.coordinator.fault("thread", new Error("session fault"));
      if (reason === "failed") read.reject(new Error("broker disconnected"));
      else
        read.resolve({
          ...new FakeHarnessSession(harnessIdSchema.parse("pi")).capabilities,
          steer: true,
        });
      await rejected;
      expect(f.insert).not.toHaveBeenCalled();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.start).not.toHaveBeenCalled();
      expect(f.coordinator.hasPending()).toBe(false);
    },
  );

  it("reserves the Thread during remote capability reads and coalesces retries", async () => {
    const f = fixture();
    const read =
      Promise.withResolvers<Awaited<ReturnType<NonNullable<HarnessSession["readCapabilities"]>>>>();
    const readCapabilities = vi.fn(() => read.promise);
    const thread = Object.assign(f.thread, { session: { ...f.thread.session, readCapabilities } });
    const first = f.coordinator.run(thread, f.params, f.start, f.insert);
    const retry = f.coordinator.run(thread, f.params, f.start, f.insert);
    expect(f.coordinator.hasPending("thread")).toBe(true);
    await expect(
      f.coordinator.run(thread, { ...f.params, clientUserMessageId: "another" }, f.start, f.insert),
    ).rejects.toMatchObject({ code: -32072 });
    read.resolve({
      ...new FakeHarnessSession(harnessIdSchema.parse("pi")).capabilities,
      steer: true,
    });
    await expect(first).resolves.toMatchObject({ delivery: "activeTurn" });
    await expect(retry).resolves.toMatchObject({ delivery: "activeTurn" });
    expect(readCapabilities).toHaveBeenCalledOnce();
    expect(f.insert).toHaveBeenCalledOnce();
    expect(f.coordinator.hasPending()).toBe(false);
  });

  it("decides delivery from the live capability, and always restarts for commands", () => {
    const f = fixture();
    expect(externalSteeringDelivery(f.thread, "go")).toBe("newTurn");
    f.thread.session.capabilities.steer = true;
    expect(externalSteeringDelivery(f.thread, "go")).toBe("activeTurn");
    const withCommands = {
      ...f.thread,
      session: {
        ...f.thread.session,
        commands: {
          list: async () => ({ ok: true, value: { commands: [] } }),
          execute: async () => ({ ok: true, value: { turnId: hostTurnIdSchema.parse("x") } }),
        } satisfies NonNullable<HarnessSession["commands"]>,
      },
    };
    expect(externalSteeringDelivery(withCommands, "/compact now")).toBe("newTurn");
    expect(externalSteeringDelivery(withCommands, "compact now")).toBe("activeTurn");
  });
});
