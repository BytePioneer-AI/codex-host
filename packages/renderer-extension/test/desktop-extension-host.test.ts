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
  };
  host.bind(bridge);
  return {
    host,
    row,
    watch,
    stopWatch,
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
