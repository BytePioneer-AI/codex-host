import { afterEach, describe, expect, it, vi } from "vitest";
import {
  rendererRemoteSession,
  type RemoteSessionTarget,
} from "../src/renderer-remote-sessions.js";

function fixture() {
  const hostId = "remote-ssh-discovered:recovery";
  let enabled = true;
  let status: { state: string; error: string | null } = {
    state: "disconnected",
    error: null,
  };
  const connect = vi.fn<() => Promise<void>>(async () => {
    status = { state: "disconnected", error: "ECONNREFUSED" };
    throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  });
  const catalog = () => [{ hostId, displayName: "recovery", autoConnect: enabled }];
  const target: RemoteSessionTarget = {
    __codexhostHostRoutingV1: {
      knownHostIds: () => [hostId],
      forHost: () => (status.state === "connected" ? { manager: { sendRequest() {} } } : null),
    },
    __codexhostRendererBindingProbeV1: {
      async remoteConnections(input) {
        const op = input as { action: string };
        if (op.action === "catalog") return catalog();
        if (op.action === "state") return status;
        return connect();
      },
    },
  };
  return {
    target,
    connect,
    hosts: () => rendererRemoteSession(target, { kind: "hosts" }),
    enable(value: boolean) {
      enabled = value;
    },
    status(value: typeof status) {
      status = value;
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("enabled native remote connection recovery", () => {
  it("retries a confirmed failure only after backoff and coalesces concurrent hosts reads", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const f = fixture();
    await Promise.all([f.hosts(), f.hosts(), f.hosts()]);
    expect(f.connect).toHaveBeenCalledTimes(1);
    now = 4_999;
    await f.hosts();
    expect(f.connect).toHaveBeenCalledTimes(1);
    now = 5_000;
    f.connect.mockImplementation(async () => {
      f.status({ state: "connected", error: null });
    });
    const hosts = await Promise.all([f.hosts(), f.hosts(), f.hosts()]);
    expect(f.connect).toHaveBeenCalledTimes(2);
    expect(hosts).toEqual(
      Array.from({ length: 3 }, () => [
        expect.objectContaining({ online: true, state: "connected" }),
      ]),
    );
    now = 100_000;
    await f.hosts();
    expect(f.connect).toHaveBeenCalledTimes(2);
  });

  it("caps exponential backoff at 30 seconds", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const f = fixture();
    await f.hosts();
    let calls = 1;
    for (const delay of [5_000, 10_000, 20_000, 30_000, 30_000]) {
      now += delay - 1;
      await f.hosts();
      expect(f.connect).toHaveBeenCalledTimes(calls);
      now += 1;
      await f.hosts();
      expect(f.connect).toHaveBeenCalledTimes(++calls);
    }
  });

  it.each(["disabled", "connected", "connecting"])("does not reconnect a %s host", async (mode) => {
    const f = fixture();
    if (mode === "disabled") f.enable(false);
    else f.status({ state: mode, error: null });
    await f.hosts();
    expect(f.connect).not.toHaveBeenCalled();
  });

  it("honors disabling autoConnect after a failed attempt, even when backoff expires", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const f = fixture();
    await f.hosts();
    f.enable(false);
    now = 60_000;
    await f.hosts();
    expect(f.connect).toHaveBeenCalledTimes(1);
  });

  it.each(["unknown result", "Codex SSH request timed out; refresh before retrying"])(
    "does not replay %s even with a stale native error",
    async (message) => {
      let now = 0;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const f = fixture();
      f.status({ state: "disconnected", error: "ECONNREFUSED" });
      f.connect.mockRejectedValue(new Error(message));
      await f.hosts();
      now = 1_000_000;
      await Promise.all([f.hosts(), f.hosts()]);
      expect(f.connect).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves unknown one-shot outcomes left by an older Controller", async () => {
    const f = fixture();
    f.target.__codexhostRemoteSessionsV1 = {
      managers: new WeakMap(),
      reconnectAttempts: new Set(["remote-ssh-discovered:recovery"]),
    };
    await f.hosts();
    expect(f.connect).not.toHaveBeenCalled();
  });

  it("retries an acknowledged native failure that remains disconnected", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const f = fixture();
    f.connect.mockImplementation(async () => {
      f.status({ state: "disconnected", error: "Native connection failed" });
    });
    await f.hosts();
    now = 5_000;
    await f.hosts();
    expect(f.connect).toHaveBeenCalledTimes(2);
  });

  it("does not replay when post-dispatch state cannot confirm failure", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const f = fixture();
    const api = f.target.__codexhostRendererBindingProbeV1;
    if (!api) throw new Error("Missing fixture API");
    const request = api.remoteConnections;
    let reads = 0;
    api.remoteConnections = async (input) => {
      if ((input as { action: string }).action === "state" && ++reads === 3)
        throw new Error("State unavailable");
      return request(input);
    };
    await f.hosts();
    now = 1_000_000;
    await f.hosts();
    expect(f.connect).toHaveBeenCalledTimes(1);
  });

  it("coalesces an in-flight native attempt while time advances", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const f = fixture();
    let finish: () => void = () => {};
    let start: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    f.connect.mockImplementation(async () => {
      start();
      await pending;
      f.status({ state: "connected", error: null });
    });
    const first = f.hosts();
    await started;
    now = 1_000_000;
    const second = f.hosts();
    finish();
    await Promise.all([first, second]);
    expect(f.connect).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch from an old catalog after the user disables the host", async () => {
    const f = fixture();
    const api = f.target.__codexhostRendererBindingProbeV1;
    if (!api) throw new Error("Missing fixture API");
    const request = api.remoteConnections;
    api.remoteConnections = async (input) => {
      const result = await request(input);
      if ((input as { action: string }).action === "state") f.enable(false);
      return result;
    };
    await f.hosts();
    expect(f.connect).not.toHaveBeenCalled();
  });
});
