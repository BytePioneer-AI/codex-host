// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { DesktopExtensionApiV1, ThreadTreeSnapshot } from "@codexhost/shared-contracts";
import {
  createDesktopExtensionHost,
  type DesktopExtensionEntry,
} from "../src/desktop-extension-host.js";
import {
  createDesktopTreeRelay,
  openLocalExtensionThread,
  type DesktopExtensionBridge,
  type DesktopExtensionRuntimeApiV1,
} from "../src/desktop-extension-api.js";

const fixtures: Array<ReturnType<typeof createDesktopExtensionHost>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const host of fixtures.splice(0)) await host.disposeAll();
  document.body.replaceChildren();
});

function setup() {
  const host = createDesktopExtensionHost(document);
  fixtures.push(host);
  const listen = new Set<() => void>();
  let snapshot: ((tree: ThreadTreeSnapshot) => void) | undefined;
  const stopWatch = vi.fn();
  const watch = vi.fn((receive: (tree: ThreadTreeSnapshot) => void) => {
    snapshot = receive;
    return stopWatch;
  });
  const tree = createDesktopTreeRelay(watch);
  const row = document.createElement("div");
  document.body.append(row);
  let nextThreadId = "local-thread";
  const handle = {
    element: row,
    hostId: () => "local",
    threadId: () => nextThreadId,
    draftId: () => null,
    isConnected: () => row.isConnected,
  };
  const readAsset = vi.fn(async (_id: string, relativePath: string) => ({
    mimeType: "image/png",
    dataUrl: `data:image/png;base64,${relativePath}`,
  }));
  let storedSettings: Record<string, Record<string, unknown>> = {};
  const getSettings = vi.fn(async (id: string) => storedSettings[id] ?? {});
  const setSettings = vi.fn(async (id: string, values: Record<string, unknown>) => {
    const next = { ...values };
    storedSettings = { ...storedSettings, [id]: next };
    return next;
  });
  const invokeBackend = vi.fn(async (id: string, method: string, params?: unknown) => ({
    id,
    method,
    params,
  }));
  const bridge: DesktopExtensionBridge = {
    ready: () => true,
    sidebar: {
      rows: () => [handle],
      observe(callback) {
        listen.add(callback);
        return () => listen.delete(callback);
      },
    },
    watchTree: tree.subscribe,
    describe: () => undefined,
    openThread: vi.fn(),
    readAsset,
    getSettings,
    setSettings,
    invokeBackend,
  };
  host.bind(bridge);
  return {
    host,
    row,
    watch,
    stopWatch,
    readAsset,
    getSettings,
    setSettings,
    invokeBackend,
    update() {
      nextThreadId += "-next";
      for (const callback of listen) callback();
    },
    emit(tree: ThreadTreeSnapshot) {
      snapshot?.(tree);
    },
  };
}

function entry(
  id: string,
  hash: string,
  activate: Parameters<
    Parameters<NonNullable<DesktopExtensionEntry["defineScript"]>>[0]
  >[0]["activate"],
): DesktopExtensionEntry {
  return { id, hash, slots: [], defineScript: (define) => define({ activate }) };
}

it("keeps unchanged hashes in place and cleans the old instance before activating an update", async () => {
  const { host } = setup();
  const calls: string[] = [];
  const first = entry("a", "old", () => {
    calls.push("old");
    return () => {
      calls.push("cleanup");
    };
  });
  await host.reconcile([first]);
  await host.reconcile([{ id: "a", hash: "old", slots: [] }]);
  await host.reconcile([
    entry("a", "new", () => {
      calls.push("new");
    }),
  ]);
  expect(calls).toEqual(["old", "cleanup", "new"]);
});

it("removes registered mounts and marks without cooperative cleanup", async () => {
  const { host, row } = setup();
  const badge = document.createElement("span");
  let api: DesktopExtensionApiV1 | undefined;
  await host.reconcile([
    entry("tree", "hash", (value) => {
      api = value;
      value.dom.mark(row, "hidden");
      value.dom.mount(badge, row);
    }),
  ]);
  expect(row.hasAttribute("data-cx-tree-hidden")).toBe(true);
  expect(badge.isConnected).toBe(true);
  await host.reconcile([]);
  expect(row.hasAttribute("data-cx-tree-hidden")).toBe(false);
  expect(badge.isConnected).toBe(false);
  expect(api?.signal.aborted).toBe(true);
  await expect(api?.navigate.openThread("local-thread")).rejects.toThrow();
});

it("forces reclamation after a timed-out cleanup and records the diagnostic", async () => {
  vi.useFakeTimers();
  const { host, row } = setup();
  const node = document.createElement("i");
  await host.reconcile([
    entry("tree", "hash", (api) => {
      api.dom.mount(node, row);
      return () => new Promise<void>(() => undefined);
    }),
  ]);
  const disabled = host.reconcile([]);
  await vi.advanceTimersByTimeAsync(1_001);
  await disabled;
  expect(node.isConnected).toBe(false);
  expect(host.status().tree).toMatchObject({ state: "disabled", error: "Cleanup timed out" });
});

it("shares one Host watch and discards later deliveries after unmount", async () => {
  const { host, watch, stopWatch, emit } = setup();
  const receiveA = vi.fn();
  const receiveB = vi.fn();
  const a = entry("a", "hash", (api) => {
    api.threads.watchTree(receiveA);
  });
  const b = entry("b", "hash", (api) => {
    api.threads.watchTree(receiveB);
  });
  await host.reconcile([a, b]);
  const snapshot = { revision: 10, parents: {}, nodes: {}, truncated: false };
  emit(snapshot);
  await host.reconcile([b]);
  emit({ ...snapshot, revision: 11 });
  expect(receiveA.mock.calls).toEqual([[snapshot]]);
  expect(receiveB).toHaveBeenCalledTimes(2);
  expect(watch).toHaveBeenCalledOnce();
  expect(stopWatch).not.toHaveBeenCalled();
  await host.reconcile([]);
  emit({ ...snapshot, revision: 12 });
  expect(receiveB).toHaveBeenCalledTimes(2);
  expect(stopWatch).toHaveBeenCalledOnce();
});

it("quarantines one persistently failing callback and preserves unrelated extensions", async () => {
  const { host, update, row } = setup();
  const node = document.createElement("i");
  const good = vi.fn();
  await host.reconcile([
    entry("bad", "bad-hash", (api) => {
      api.dom.mount(node, row);
      api.sidebar.observeRows(() => {
        throw new Error("bad sidebar callback");
      });
    }),
    entry("good", "good-hash", (api) => {
      api.sidebar.observeRows(good);
    }),
  ]);
  for (let i = 0; i < 5; i++) update();
  await vi.waitFor(() => expect(node.isConnected).toBe(false));
  expect(host.status()).toMatchObject({
    bad: { state: "failed", error: "bad sidebar callback" },
    good: { state: "running" },
  });
  expect(good).toHaveBeenCalledTimes(6);
});

it("does not activate a competing extension that reaches the registry", async () => {
  const { host } = setup();
  const first = vi.fn();
  const second = vi.fn();
  await host.reconcile([
    { ...entry("first", "hash", first), slots: ["sidebar.thread-layout"] },
    {
      ...entry("second", "hash", second),
      slots: ["sidebar.thread-layout", "sidebar.thread-badge"],
    },
  ]);
  expect(first).toHaveBeenCalledOnce();
  expect(second).not.toHaveBeenCalled();
  expect(host.status().second).toMatchObject({ state: "conflict", conflictWith: "first" });
});

it("blocks remote and unknown Thread navigation", async () => {
  const navigate = vi.fn();
  const exists = vi.fn(async (id) => id !== "unknown");
  const signal = new AbortController().signal;
  const row = {
    element: document.createElement("div"),
    hostId: () => "remote",
    threadId: () => "remote-id",
    draftId: () => null,
    isConnected: () => true,
  };
  await expect(
    openLocalExtensionThread("remote-id", signal, [row], exists, navigate),
  ).rejects.toThrow("Unknown local");
  await expect(
    openLocalExtensionThread("unknown", signal, [row], exists, navigate),
  ).rejects.toThrow("Unknown local");
  expect(navigate).not.toHaveBeenCalled();
  await openLocalExtensionThread("delegated-child", signal, [], exists, navigate);
  expect(navigate).toHaveBeenCalledWith("delegated-child", signal);
});

it("exposes assets, storage (with onChange fan-out & cleanup), backend invoke, and single-page settings registration", async () => {
  const { host, readAsset, getSettings, setSettings, invokeBackend } = setup();
  const pageEvents = vi.fn();
  const stopListeningPages = host.subscribeSettingsPages(pageEvents);
  const storageEventsA = vi.fn();
  const storageEventsB = vi.fn();
  let runtimeApi: DesktopExtensionRuntimeApiV1 | undefined;

  await host.reconcile([
    {
      ...entry("aurora", "hash-1", (api) => {
        const ext = api as DesktopExtensionRuntimeApiV1;
        runtimeApi = ext;
        ext.storage.onChange(storageEventsA);
        ext.storage.onChange(storageEventsB);
        // Repeated registerPage replaces the previous registration (at most 1 page per extension).
        ext.settings.registerPage({
          title: { en: "Old Title", "zh-CN": "旧标题" },
          mount: () => undefined,
        });
        ext.settings.registerPage({
          title: { en: "Aurora Theme", "zh-CN": "极光主题" },
          icon: "appearance" as never,
          mount: () => undefined,
        });
      }),
      slots: ["appearance.theme"],
    },
  ]);

  expect(host.getRegisteredSettingsPages()).toHaveLength(1);
  expect(host.getRegisteredSettingsPages()[0]).toMatchObject({
    extensionId: "aurora",
    kind: "custom",
    title: { en: "Aurora Theme", "zh-CN": "极光主题" },
  });
  expect(pageEvents).toHaveBeenCalled();

  if (!runtimeApi) throw new Error("Expected runtime API to be captured during activation");

  await expect(runtimeApi.assets.readDataUrl("wallpapers/bg.png")).resolves.toEqual({
    mimeType: "image/png",
    dataUrl: "data:image/png;base64,wallpapers/bg.png",
  });
  expect(readAsset).toHaveBeenCalledWith("aurora", "wallpapers/bg.png");

  await expect(runtimeApi.storage.get()).resolves.toEqual({});
  expect(getSettings).toHaveBeenCalledWith("aurora");

  await expect(runtimeApi.storage.set({ opacity: 0.8 })).resolves.toEqual({ opacity: 0.8 });
  expect(setSettings).toHaveBeenCalledWith("aurora", { opacity: 0.8 });
  expect(storageEventsA).toHaveBeenCalledWith({ opacity: 0.8 });
  expect(storageEventsB).toHaveBeenCalledWith({ opacity: 0.8 });

  await expect(runtimeApi.backend.invoke("theme.scan", { dir: "wallpapers" })).resolves.toEqual({
    id: "aurora",
    method: "theme.scan",
    params: { dir: "wallpapers" },
  });
  expect(invokeBackend).toHaveBeenCalledWith("aurora", "theme.scan", { dir: "wallpapers" });

  // Disabling the extension automatically unregisters its settings page and cleans up storage listeners.
  pageEvents.mockClear();
  storageEventsA.mockClear();
  await host.reconcile([]);
  expect(host.getRegisteredSettingsPages()).toEqual([]);
  expect(pageEvents).toHaveBeenCalled();

  host.notifyStorageChange("aurora", { opacity: 0.5 });
  expect(storageEventsA).not.toHaveBeenCalled();
  await expect(runtimeApi.storage.get()).rejects.toThrow();

  stopListeningPages();
});
