import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessDisplayEntries, HarnessDisplaySet } from "@codexhost/shared-contracts";
import { createAgentGroupPreferenceStore } from "../src/agent-group-preference.js";
import { startAgentGroupSync } from "../src/agent-group-sync.js";

function host() {
  let entries: HarnessDisplayEntries | null = null;
  return {
    getHarnessDisplaySettings: vi.fn(async () => ({ entries })),
    setHarnessDisplaySettings: vi.fn(async (input: HarnessDisplaySet) => {
      if (!input.initializeOnly || entries === null) entries = input.entries;
      return { entries };
    }),
  };
}
const settle = () => vi.advanceTimersByTimeAsync(0);
afterEach(() => vi.useRealTimers());

describe("Web and Desktop Harness preference synchronization", () => {
  it("migrates Desktop only, shares edits both ways, resets and survives reconnect", async () => {
    vi.useFakeTimers();
    const client = host();
    const webStorage = {
      getItem: vi.fn(() => JSON.stringify([{ agent: "grok", section: "more" }])),
    };
    const web = createAgentGroupPreferenceStore(webStorage);
    const stopWeb = startAgentGroupSync(web, () => client, { migrateLegacy: false });
    await settle();
    expect(client.setHarnessDisplaySettings).not.toHaveBeenCalled();
    expect(webStorage.getItem).not.toHaveBeenCalled();
    const desktopStorage = {
      getItem: vi.fn(() => JSON.stringify([{ agent: "claude-code", section: "main" }])),
    };
    const desktop = createAgentGroupPreferenceStore(desktopStorage);
    const stopDesktop = startAgentGroupSync(desktop, () => client, { migrateLegacy: true });
    await settle();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(web.list()).toEqual(desktop.list());
    expect(web.list()[0]?.agent).toBe("claude-code");
    web.moveAgent("grok", "main", "claude-code");
    await settle();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(desktop.list()[0]?.agent).toBe("grok");
    desktop.moveAgent("pi", "more");
    await settle();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(web.sectionOf("pi")).toBe("more");
    web.resetToDefault();
    await settle();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(desktop.list()).toEqual(createAgentGroupPreferenceStore(null).list());
    stopDesktop();
    const staleStorage = {
      getItem: vi.fn(() => JSON.stringify([{ agent: "pi", section: "more" }])),
    };
    const reloaded = createAgentGroupPreferenceStore(staleStorage);
    const stopReloaded = startAgentGroupSync(reloaded, () => client, { migrateLegacy: true });
    await settle();
    expect(reloaded.sectionOf("pi")).toBe("main");
    expect(staleStorage.getItem).not.toHaveBeenCalled();
    expect(desktopStorage.getItem).toHaveBeenCalledTimes(1);
    stopWeb();
    stopReloaded();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recovers after Host loss without writing stale local settings over shared data", async () => {
    vi.useFakeTimers();
    const client = host();
    let connected = false;
    const store = createAgentGroupPreferenceStore({
      getItem: () => JSON.stringify([{ agent: "pi", section: "more" }]),
    });
    await client.setHarnessDisplaySettings({
      entries: [
        { agent: "grok", section: "main" },
        { agent: "future-harness", section: "more" },
      ],
    });
    const stop = startAgentGroupSync(store, () => (connected ? client : null), {
      migrateLegacy: true,
    });
    await settle();
    expect(store.syncStatus()).toBe("error");
    connected = true;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(store.syncStatus()).toBe("ready");
    expect(store.list()[0]?.agent).toBe("grok");
    expect(store.sectionOf("pi")).toBe("main");
    store.moveAgent("pi", "more");
    await settle();
    expect((await client.getHarnessDisplaySettings()).entries).toContainEqual({
      agent: "future-harness",
      section: "more",
    });
    stop();
  });

  it("keeps the confirmed order on a failed write and supports retry", async () => {
    vi.useFakeTimers();
    const client = host();
    const store = createAgentGroupPreferenceStore(null);
    const stop = startAgentGroupSync(store, () => client, { migrateLegacy: false });
    await settle();
    const before = store.list();
    client.setHarnessDisplaySettings.mockRejectedValueOnce(new Error("offline"));
    store.moveAgent("grok", "main", "pi");
    await settle();
    expect(store.syncStatus()).toBe("error");
    expect(store.list()).toEqual(before);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(store.syncStatus()).toBe("error");
    store.moveAgent("grok", "main", "pi");
    await settle();
    expect(store.syncStatus()).toBe("ready");
    expect(store.list()[0]?.agent).toBe("grok");
    stop();
  });

  it("ignores an old poll response arriving after a save", async () => {
    vi.useFakeTimers();
    const client = host();
    const store = createAgentGroupPreferenceStore(null);
    const stop = startAgentGroupSync(store, () => client, { migrateLegacy: false });
    await settle();
    let resolveRead: (value: { entries: HarnessDisplayEntries | null }) => void = () => undefined;
    client.getHarnessDisplaySettings.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(3_000);
    store.moveAgent("grok", "main", "pi");
    await settle();
    resolveRead({ entries: [] });
    await settle();
    expect(store.list()[0]?.agent).toBe("grok");
    stop();
  });

  it("does not apply a delayed response or allow local-only writes after disposal", async () => {
    vi.useFakeTimers();
    const client = host();
    const store = createAgentGroupPreferenceStore(null);
    let resolveRead: (value: { entries: HarnessDisplayEntries | null }) => void = () => undefined;
    client.getHarnessDisplaySettings.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    const stop = startAgentGroupSync(store, () => client, { migrateLegacy: true });
    stop();
    resolveRead({ entries: [{ agent: "grok", section: "more" }] });
    await settle();
    store.moveAgent("pi", "more");
    expect(store.sectionOf("pi")).toBe("main");
    expect(client.setHarnessDisplaySettings).not.toHaveBeenCalled();
  });
});

describe("event-driven Harness display synchronization", () => {
  function eventHost() {
    const client = host();
    const listeners = new Set<() => void>();
    const publish = () => {
      for (const listener of listeners) listener();
    };
    const set = client.setHarnessDisplaySettings.getMockImplementation();
    if (!set) throw new Error("Missing Host implementation");
    client.setHarnessDisplaySettings.mockImplementation(async (input) => {
      const result = await set(input);
      publish();
      return result;
    });
    return Object.assign(client, {
      getHarnessDisplayCapabilities: vi.fn(async () => ({ events: true })),
      subscribeHarnessDisplaySettings: vi.fn((listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      publish,
      listeners,
    });
  }
  it("syncs GUI, Web and Console writes with no idle reads and removes subscriptions", async () => {
    vi.useFakeTimers();
    const client = eventHost();
    const stores = Array.from({ length: 3 }, () => createAgentGroupPreferenceStore(null));
    const stops = stores.map((store) =>
      startAgentGroupSync(store, () => client, { migrateLegacy: false }),
    );
    await settle();
    client.getHarnessDisplaySettings.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.getHarnessDisplaySettings).not.toHaveBeenCalled();
    for (const [index, store] of stores.entries()) {
      store.moveAgent(`agent-${index}`, "more");
      await settle();
      for (const other of stores) expect(other.sectionOf(`agent-${index}`)).toBe("more");
    }
    const confirmed = stores[0]?.list();
    client.setHarnessDisplaySettings.mockRejectedValueOnce(new Error("failed write"));
    stores[0]?.moveAgent("failed", "more");
    await settle();
    expect(stores[0]?.list()).toEqual(confirmed);
    expect(stores[1]?.list()).toEqual(confirmed);
    stops.forEach((stop) => stop());
    expect(client.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("subscribes before initial read and coalesces notifications arriving during reads", async () => {
    vi.useFakeTimers();
    const client = eventHost();
    let finish: (value: { entries: HarnessDisplayEntries }) => void = () => {};
    client.getHarnessDisplaySettings.mockImplementationOnce(() => {
      expect(client.listeners.size).toBe(1);
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const store = createAgentGroupPreferenceStore(null);
    const stop = startAgentGroupSync(store, () => client, { migrateLegacy: false });
    client.publish();
    client.publish();
    client.publish();
    expect(client.getHarnessDisplaySettings).toHaveBeenCalledTimes(1);
    await client.setHarnessDisplaySettings({ entries: [{ agent: "latest", section: "more" }] });
    finish({ entries: [] });
    await settle();
    expect(client.getHarnessDisplaySettings).toHaveBeenCalledTimes(2);
    expect(store.sectionOf("latest")).toBe("more");
    stop();
  });
  it("rejects late reads and writes from replaced clients", async () => {
    vi.useFakeTimers();
    const old = eventHost();
    const next = eventHost();
    let current = old;
    const store = createAgentGroupPreferenceStore(null);
    const stop = startAgentGroupSync(store, () => current, { migrateLegacy: false });
    await settle();
    let finish: (value: { entries: HarnessDisplayEntries }) => void = () => {};
    old.setHarnessDisplaySettings.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    store.moveAgent("old", "more");
    await next.setHarnessDisplaySettings({ entries: [{ agent: "new", section: "more" }] });
    current = next;
    stop.connect();
    await settle();
    finish({ entries: [{ agent: "old", section: "more" }] });
    await settle();
    expect(store.sectionOf("new")).toBe("more");
    expect(store.sectionOf("old")).toBe("main");
    expect(old.listeners.size).toBe(0);
    stop();
  });
  it("uses explicit unsupported capability as a legacy fallback", async () => {
    vi.useFakeTimers();
    const client = eventHost();
    client.getHarnessDisplayCapabilities.mockResolvedValue({ events: false });
    const stop = startAgentGroupSync(createAgentGroupPreferenceStore(null), () => client, {
      migrateLegacy: false,
    });
    await settle();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(client.getHarnessDisplaySettings).toHaveBeenCalledTimes(2);
    stop();
  });
});

it("reads on focus/visibility recovery and removes recovery listeners", async () => {
  vi.useFakeTimers();
  const client = host();
  const owner = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: "hidden" });
  Object.assign(owner, { document });
  const stop = startAgentGroupSync(createAgentGroupPreferenceStore(null), () => client, {
    migrateLegacy: false,
    owner: owner as Window,
  });
  await settle();
  client.getHarnessDisplaySettings.mockClear();
  document.dispatchEvent(new Event("visibilitychange"));
  await settle();
  expect(client.getHarnessDisplaySettings).not.toHaveBeenCalled();
  document.visibilityState = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  await settle();
  owner.dispatchEvent(new Event("focus"));
  await settle();
  expect(client.getHarnessDisplaySettings).toHaveBeenCalledTimes(2);
  stop();
  owner.dispatchEvent(new Event("focus"));
  document.dispatchEvent(new Event("visibilitychange"));
  await settle();
  expect(client.getHarnessDisplaySettings).toHaveBeenCalledTimes(2);
});

it("falls back only on explicit method absence, not capability transport failure", async () => {
  vi.useFakeTimers();
  for (const [code, reads] of [
    [-32601, 2],
    [-32093, 1],
  ]) {
    const client = Object.assign(host(), {
      subscribeHarnessDisplaySettings: () => () => {},
      getHarnessDisplayCapabilities: async () => {
        throw Object.assign(new Error("unavailable"), { code });
      },
    });
    const stop = startAgentGroupSync(createAgentGroupPreferenceStore(null), () => client, {
      migrateLegacy: false,
    });
    await settle();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(client.getHarnessDisplaySettings).toHaveBeenCalledTimes(reads ?? 0);
    stop();
  }
});
