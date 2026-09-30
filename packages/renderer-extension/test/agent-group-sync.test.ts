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
