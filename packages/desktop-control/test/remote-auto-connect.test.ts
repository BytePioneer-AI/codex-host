import { afterEach, describe, expect, it, vi } from "vitest";
import { createAutoConnectRestore } from "../src/remote-auto-connect.js";

function fixture() {
  const hostId = "remote-ssh-discovered:a";
  let enabled = true;
  let status = { state: "disconnected", error: "ECONNREFUSED" as string | null };
  const control = {
    list: vi.fn(async () => [{ hostId, autoConnect: enabled }]),
    state: vi.fn(async () => status),
    connect: vi.fn(async (_hostId: string, next: boolean) => {
      enabled = next;
    }),
  };
  const recovery = createAutoConnectRestore(control);
  return {
    hostId,
    control,
    recovery,
    enable(value: boolean) {
      enabled = value;
    },
    status(state: string, error: string | null = null) {
      status = { state, error };
    },
    restore: () => recovery.restore(hostId),
  };
}

afterEach(() => vi.restoreAllMocks());
describe("SSH recovery on shared host reads", () => {
  it.each(["disconnected", "error"])("toggles an enabled SSH host in %s", async (state) => {
    const f = fixture();
    f.status(state, "native connection failed");
    await f.restore();
    expect(f.control.connect.mock.calls).toEqual([
      [f.hostId, false],
      [f.hostId, true],
    ]);
  });

  it("retries failed observations before any native write", async () => {
    const f = fixture();
    f.control.state.mockRejectedValueOnce(new Error("not ready"));
    await f.restore();
    await f.restore();
    expect(f.control.connect).toHaveBeenCalledTimes(2);
  });

  it("backs off indefinitely and reconnects after a late network recovery", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const f = fixture();
    await f.restore();
    let calls = 2;
    for (const delay of [5_000, 10_000, 20_000, 30_000, 30_000, 30_000]) {
      now += delay - 1;
      await f.restore();
      expect(f.control.connect).toHaveBeenCalledTimes(calls);
      now += 1;
      await f.restore();
      calls += 2;
      expect(f.control.connect).toHaveBeenCalledTimes(calls);
    }
    now += 30_000;
    f.control.connect.mockImplementation(async (_id, next) => {
      if (next) f.status("connected");
    });
    expect(await f.restore()).toBe(true);
    expect(f.control.connect.mock.calls.slice(-2)).toEqual([
      [f.hostId, false],
      [f.hostId, true],
    ]);
  });

  it("does not let an old state observation invalidate a newer recovery", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const f = fixture();
    await f.restore();
    const oldState = Promise.withResolvers<{ state: string; error: string | null }>();
    const off = Promise.withResolvers<undefined>();
    f.control.state.mockReturnValueOnce(oldState.promise);
    now = 1_000;
    const observing = f.restore();
    now = 5_000;
    f.control.connect.mockImplementation(async (_id, enabled) => {
      if (!enabled) await off.promise;
    });
    const recovering = f.restore();
    await vi.waitFor(() => expect(f.control.connect).toHaveBeenCalledTimes(3));
    oldState.resolve({ state: "connected", error: null });
    expect(await observing).toBe(false);
    off.resolve(undefined);
    await recovering;
    expect(f.control.connect).toHaveBeenCalledTimes(4);
  });

  it("coalesces concurrent restores of one host", async () => {
    const f = fixture();
    const pending = Promise.withResolvers<undefined>();
    f.control.connect.mockImplementation(async () => {
      await pending.promise;
    });
    const first = f.restore();
    await vi.waitFor(() => expect(f.control.connect).toHaveBeenCalledTimes(1));
    const second = f.restore();
    expect(second).toBe(first);
    pending.resolve(undefined);
    await Promise.all([first, second]);
    expect(f.control.connect).toHaveBeenCalledTimes(2);
  });

  it.each(["disabled", "connected", "connecting", "no SSH", "unreadable"])(
    "does not toggle %s",
    async (mode) => {
      const f = fixture();
      if (mode === "disabled") f.enable(false);
      if (mode === "connected" || mode === "connecting") f.status(mode);
      if (mode === "no SSH") f.control.list.mockResolvedValue([]);
      if (mode === "unreadable") f.control.state.mockRejectedValue(new Error("unavailable"));
      await f.restore();
      expect(f.control.connect).not.toHaveBeenCalled();
      expect(await f.recovery.restore("remote-control:b")).toBe(false);
    },
  );

  it("revalidates the catalog after awaiting state", async () => {
    const f = fixture();
    f.control.state.mockImplementation(async () => {
      f.enable(false);
      return { state: "disconnected", error: null };
    });
    await f.restore();
    expect(f.control.connect).not.toHaveBeenCalled();
  });

  it.each(["state", "off"])(
    "does not reopen after explicit cancellation while awaiting %s",
    async (phase) => {
      const f = fixture();
      const pending = Promise.withResolvers<undefined>();
      if (phase === "state")
        f.control.state.mockImplementation(async () => {
          await pending.promise;
          return { state: "disconnected", error: null };
        });
      else
        f.control.connect.mockImplementation(async () => {
          await pending.promise;
        });
      const running = f.restore();
      await vi.waitFor(() =>
        expect(phase === "state" ? f.control.state : f.control.connect).toHaveBeenCalledTimes(1),
      );
      const closing = f.recovery.runExplicit(f.hostId, async () => {
        f.enable(false);
      });
      pending.resolve(undefined);
      await Promise.all([running, closing]);
      await f.restore();
      expect(f.control.connect.mock.calls.some(([, next]) => next)).toBe(false);
    },
  );

  it("does not replay unknown writes or keep a reenable debt", async () => {
    const f = fixture();
    f.control.connect.mockImplementation(async (_id, next) => {
      f.enable(next);
      if (next) throw new Error("Codex SSH request timed out; refresh before retrying");
    });
    await f.restore();
    await f.restore();
    expect(f.control.connect).toHaveBeenCalledTimes(2);
    await f.recovery.runExplicit(f.hostId, async () => {
      f.enable(false);
    });
    await f.restore();
    expect(f.control.connect).toHaveBeenCalledTimes(2);
  });

  it("queues explicit off behind an already dispatched on and blocks further recovery", async () => {
    const f = fixture();
    const pending = Promise.withResolvers<undefined>();
    f.control.connect.mockImplementation(async (_id, enabled) => {
      if (enabled) await pending.promise;
      f.enable(enabled);
    });
    const running = f.restore();
    await vi.waitFor(() => expect(f.control.connect).toHaveBeenCalledTimes(2));
    const closing = f.recovery.runExplicit(f.hostId, () => f.control.connect(f.hostId, false));
    const concurrent = f.restore();
    expect(f.control.connect).toHaveBeenCalledTimes(2);
    pending.resolve(undefined);
    await Promise.all([running, closing, concurrent]);
    await f.restore();
    expect(f.control.connect.mock.calls.map(([, enabled]) => enabled)).toEqual([
      false,
      true,
      false,
    ]);
  });

  it("does not issue on after an unknown off outcome", async () => {
    const f = fixture();
    f.control.connect.mockRejectedValue(new Error("timed out"));
    await f.restore();
    await f.restore();
    expect(f.control.connect.mock.calls).toEqual([[f.hostId, false]]);
  });

  it("disposal invalidates an awaiting attempt", async () => {
    const f = fixture();
    const pending = Promise.withResolvers<{ state: string; error: string | null }>();
    f.control.state.mockReturnValue(pending.promise);
    const running = f.restore();
    await vi.waitFor(() => expect(f.control.state).toHaveBeenCalled());
    f.recovery.dispose();
    pending.resolve({ state: "disconnected", error: null });
    await running;
    await f.restore();
    expect(f.control.connect).not.toHaveBeenCalled();
  });
});
