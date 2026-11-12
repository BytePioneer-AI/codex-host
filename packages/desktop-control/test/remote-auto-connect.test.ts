import { describe, expect, it, vi } from "vitest";
import {
  AUTO_CONNECT_RESTORE_ATTEMPTS,
  autoConnectMemory,
  restoreDisconnectedAutoConnect,
  startAutoConnectRestore,
  type AutoConnectControl,
  type AutoConnectRecord,
} from "../src/remote-auto-connect.js";

function control(options: {
  hosts: AutoConnectRecord[];
  state: Record<string, string | "throw">;
  onConnect?: (hostId: string, enabled: boolean) => void;
}): AutoConnectControl & { writes: Array<{ hostId: string; enabled: boolean }> } {
  const writes: Array<{ hostId: string; enabled: boolean }> = [];
  return {
    writes,
    async list() {
      return options.hosts;
    },
    async state(hostId) {
      const value = options.state[hostId];
      if (value === "throw") throw new Error("state unavailable");
      return value ? { state: value } : null;
    },
    async connect(hostId, enabled) {
      writes.push({ hostId, enabled });
      options.onConnect?.(hostId, enabled);
    },
  };
}

describe("SSH auto-connect restore", () => {
  it("toggles a disconnected or failed auto-connect host and leaves the others", async () => {
    const owner = {};
    const api = control({
      hosts: [
        { hostId: "remote-ssh-discovered:down", autoConnect: true },
        { hostId: "remote-ssh-discovered:failed", autoConnect: true },
        { hostId: "remote-ssh-discovered:busy", autoConnect: true },
        { hostId: "remote-ssh-discovered:up", autoConnect: true },
        { hostId: "remote-ssh-discovered:off", autoConnect: false },
        { hostId: "remote-control:phone", autoConnect: true },
      ],
      state: {
        "remote-ssh-discovered:down": "disconnected",
        "remote-ssh-discovered:failed": "error",
        "remote-ssh-discovered:busy": "connecting",
        "remote-ssh-discovered:up": "connected",
        "remote-ssh-discovered:off": "disconnected",
        "remote-control:phone": "disconnected",
      },
    });
    const connected = await restoreDisconnectedAutoConnect(api, autoConnectMemory(owner));
    expect(api.writes).toEqual([
      { hostId: "remote-ssh-discovered:down", enabled: false },
      { hostId: "remote-ssh-discovered:down", enabled: true },
      { hostId: "remote-ssh-discovered:failed", enabled: false },
      { hostId: "remote-ssh-discovered:failed", enabled: true },
    ]);
    expect(connected).toEqual(["remote-ssh-discovered:up"]);
  });

  it("does not switch a host whose state cannot be read", async () => {
    const api = control({
      hosts: [{ hostId: "remote-ssh-discovered:a", autoConnect: true }],
      state: { "remote-ssh-discovered:a": "throw" },
    });
    await restoreDisconnectedAutoConnect(api, autoConnectMemory({}));
    expect(api.writes).toEqual([]);
  });

  it("retries while the host stays disconnected and then stops", async () => {
    const owner = {};
    const api = control({
      hosts: [{ hostId: "remote-ssh-discovered:a", autoConnect: true }],
      state: { "remote-ssh-discovered:a": "disconnected" },
    });
    const memory = autoConnectMemory(owner);
    for (let pass = 0; pass < AUTO_CONNECT_RESTORE_ATTEMPTS + 1; pass += 1)
      await restoreDisconnectedAutoConnect(api, memory, 2);
    expect(api.writes).toEqual([
      { hostId: "remote-ssh-discovered:a", enabled: false },
      { hostId: "remote-ssh-discovered:a", enabled: true },
      { hostId: "remote-ssh-discovered:a", enabled: false },
      { hostId: "remote-ssh-discovered:a", enabled: true },
    ]);
  });

  it("turns auto-connect back on when the off request lands and the on request does not", async () => {
    const owner = {};
    let enabled = true;
    const api = control({
      hosts: [],
      state: { "remote-ssh-discovered:a": "disconnected" },
      onConnect(hostId, next) {
        if (hostId === "remote-ssh-discovered:a" && next === false) enabled = false;
        if (next === true) throw new Error("on request lost");
      },
    });
    api.list = async () => [{ hostId: "remote-ssh-discovered:a", autoConnect: enabled }];
    const memory = autoConnectMemory(owner);
    await restoreDisconnectedAutoConnect(api, memory);
    await restoreDisconnectedAutoConnect(api, memory);
    expect(api.writes.map((write) => write.enabled)).toEqual([false, true, true]);
    expect(enabled).toBe(false);
  });

  it("keeps turning the flag on after the toggle cap when the on request failed", async () => {
    const hostId = "remote-ssh-discovered:a";
    let enabled = true;
    let allowOn = false;
    const api = control({
      hosts: [],
      state: { [hostId]: "disconnected" },
      onConnect(_id, next) {
        if (next === false) enabled = false;
        if (next === true) {
          if (!allowOn) throw new Error("on request lost");
          enabled = true;
        }
      },
    });
    api.list = async () => [{ hostId, autoConnect: enabled }];
    const memory = autoConnectMemory({});
    await restoreDisconnectedAutoConnect(api, memory, 1);
    await restoreDisconnectedAutoConnect(api, memory, 1);
    await restoreDisconnectedAutoConnect(api, memory, 1);
    expect(memory.attempts.get(hostId)).toBe(1);
    expect(memory.reenable.has(hostId)).toBe(true);
    expect(enabled).toBe(false);
    expect(api.writes.map((write) => write.enabled)).toEqual([false, true, true, true]);
    allowOn = true;
    await restoreDisconnectedAutoConnect(api, memory, 1);
    expect(enabled).toBe(true);
    expect(memory.reenable.has(hostId)).toBe(false);
    const writes = api.writes.length;
    await restoreDisconnectedAutoConnect(api, memory, 1);
    expect(api.writes).toHaveLength(writes);
    expect(enabled).toBe(true);
  });

  it("does not run a second pass while the first pass is still reading", async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const api: AutoConnectControl = {
      async list() {
        await pending;
        return [{ hostId: "remote-ssh-discovered:a", autoConnect: true }];
      },
      async state() {
        return { state: "disconnected" };
      },
      connect: vi.fn(async () => undefined),
    };
    const memory = autoConnectMemory({});
    const first = restoreDisconnectedAutoConnect(api, memory);
    await Promise.resolve();
    await expect(restoreDisconnectedAutoConnect(api, memory)).resolves.toBeNull();
    expect(api.connect).not.toHaveBeenCalled();
    release?.();
    await first;
    expect(api.connect).toHaveBeenCalledTimes(2);
  });

  it("rechecks a connected host on each startup pass and stops when disposed", async () => {
    const seen: string[] = [];
    const api = control({
      hosts: [{ hostId: "remote-ssh-discovered:a", autoConnect: true }],
      state: { "remote-ssh-discovered:a": "connected" },
    });
    const timers = new Map<number, () => void>();
    const stop = startAutoConnectRestore(
      {},
      api,
      {
        setTimeout(handler) {
          const id = timers.size + 1;
          timers.set(id, handler);
          return id;
        },
        clearTimeout(id) {
          timers.delete(Number(id));
        },
      },
      { delaysMs: [0, 0], onConnected: (hostId) => seen.push(hostId) },
    );
    timers.get(1)?.();
    await vi.waitFor(() => expect(timers.size).toBe(2));
    expect(seen).toEqual(["remote-ssh-discovered:a"]);
    const second = timers.get(2);
    stop.dispose();
    second?.();
    await Promise.resolve();
    expect(seen).toEqual(["remote-ssh-discovered:a"]);
    expect(api.writes).toEqual([]);
  });

  it("notifies later hosts and schedules the next round when one notification throws", async () => {
    const seen: string[] = [];
    const api = control({
      hosts: [
        { hostId: "remote-ssh-discovered:a", autoConnect: true },
        { hostId: "remote-ssh-discovered:b", autoConnect: true },
      ],
      state: {
        "remote-ssh-discovered:a": "connected",
        "remote-ssh-discovered:b": "connected",
      },
    });
    const timers = new Map<number, () => void>();
    startAutoConnectRestore(
      {},
      api,
      {
        setTimeout(handler) {
          const id = timers.size + 1;
          timers.set(id, handler);
          return id;
        },
        clearTimeout(id) {
          timers.delete(Number(id));
        },
      },
      {
        delaysMs: [0, 0],
        onConnected(hostId) {
          seen.push(hostId);
          if (hostId.endsWith(":a")) throw new Error("release failed");
        },
      },
    );
    timers.get(1)?.();
    await vi.waitFor(() => expect(timers.size).toBe(2));
    expect(seen).toEqual(["remote-ssh-discovered:a", "remote-ssh-discovered:b"]);
  });
});
