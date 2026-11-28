import type { JsonObject } from "@codexhost/protocol-core";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  THREAD_TREE_SNAPSHOT_METHOD,
  THREAD_TREE_WATCH_METHOD,
  harnessIdSchema,
  hostThreadIdSchema,
  threadTreeSnapshotSchema,
  threadTreeWatchResultSchema,
} from "@codexhost/shared-contracts";
import { expect, it, vi } from "vitest";
import { ClientChannelEvents } from "../src/client-channel-events.js";
import { ThreadTreeWatch, limitTreeEdges } from "../src/thread-tree-watch.js";

it("detects native archives on a cold watch even when status arrived first", async () => {
  vi.useFakeTimers();
  const codexHome = path.resolve("fixture-codex-home");
  const send = vi.fn<(message: JsonObject) => Promise<void>>(async () => {});
  const watch = new ThreadTreeWatch({
    codexHome,
    tree: { read: async () => ({ parents: { archived: "parent", active: "parent" } }) },
    repository: { listSummaries: async () => [] },
    events: new ClientChannelEvents(),
    localStatus: () => undefined,
    waiting: () => false,
    readOfficial: async (id: string) => ({
      result: {
        thread: {
          id,
          status: { type: "notLoaded" },
          path: path.join(
            codexHome,
            id === "archived" ? "archived_sessions" : "sessions",
            `${id}.jsonl`,
          ),
        },
      },
    }),
    send,
    diagnose: (error: unknown) => {
      throw error;
    },
  });
  try {
    watch.observe(
      {
        method: "thread/status/changed",
        params: { threadId: "archived", status: { type: "idle" } },
      },
      true,
    );
    await watch.handle({ id: 1, method: THREAD_TREE_WATCH_METHOD, params: {} });
    expect(
      threadTreeWatchResultSchema.parse(send.mock.lastCall?.[0].result).snapshot.nodes,
    ).toMatchObject({
      archived: { archived: true, status: "idle" },
      active: { archived: false },
    });
  } finally {
    watch.close();
    vi.useRealTimers();
  }
});

it("reprobes official threads on reconnect and ignores reads from the retired generation", async () => {
  vi.useFakeTimers();
  const stale = Promise.withResolvers<JsonObject>();
  const send = vi.fn<(message: JsonObject) => Promise<void>>(async () => {});
  const officialThread = (name: string, type: string): JsonObject => ({
    result: { thread: { id: "official", name, status: { type } } },
  });
  let reconnected = false;
  const watch = new ThreadTreeWatch({
    codexHome: path.resolve("fixture-codex-home"),
    tree: { read: async () => ({ parents: { official: "parent" } }) },
    repository: { listSummaries: async () => [] },
    events: new ClientChannelEvents(),
    localStatus: () => undefined,
    waiting: () => false,
    readOfficial: async (id) => {
      if (id !== "official") return {};
      return reconnected ? officialThread("current", "active") : stale.promise;
    },
    send,
    diagnose: (error) => {
      throw error;
    },
  });
  try {
    const start = watch.handle({ id: 1, method: THREAD_TREE_WATCH_METHOD, params: {} });
    await vi.advanceTimersByTimeAsync(200);
    await start;
    const initial = threadTreeWatchResultSchema.parse(send.mock.lastCall?.[0].result);
    expect(initial.snapshot.nodes).toHaveProperty("official.status", "unknown");
    reconnected = true;
    watch.resetOfficial();
    await vi.advanceTimersByTimeAsync(500);
    const update = send.mock.lastCall?.[0];
    expect(update?.method).toBe(THREAD_TREE_SNAPSHOT_METHOD);
    expect(threadTreeWatchResultSchema.parse(update?.params)).toMatchObject({
      subscriptionId: initial.subscriptionId,
      snapshot: { nodes: { official: { title: "current", status: "running" } } },
    });
    send.mockClear();
    stale.resolve(officialThread("stale", "idle"));
    await vi.advanceTimersByTimeAsync(500);
    expect(send).not.toHaveBeenCalled();
  } finally {
    watch.close();
    vi.useRealTimers();
  }
});

it("drops a deleted Thread from the next snapshot", async () => {
  vi.useFakeTimers();
  const send = vi.fn<(message: JsonObject) => Promise<void>>(async () => {});
  const parents: Record<string, string> = { child: "parent" };
  const watch = new ThreadTreeWatch({
    codexHome: path.resolve("fixture-codex-home"),
    tree: { read: async () => ({ parents: { ...parents } }) },
    repository: { listSummaries: async () => [] },
    events: new ClientChannelEvents(),
    localStatus: () => undefined,
    waiting: () => false,
    readOfficial: async (id) => ({
      result: { thread: { id, name: `${id} title`, status: { type: "idle" } } },
    }),
    send,
    diagnose: (error) => {
      throw error;
    },
  });
  const latest = () => {
    const message = send.mock.lastCall?.[0];
    return message?.method === THREAD_TREE_SNAPSHOT_METHOD
      ? threadTreeWatchResultSchema.parse(message.params).snapshot
      : threadTreeWatchResultSchema.parse(message?.result).snapshot;
  };
  try {
    const start = watch.handle({ id: 1, method: THREAD_TREE_WATCH_METHOD, params: {} });
    await vi.advanceTimersByTimeAsync(200);
    await start;
    await vi.advanceTimersByTimeAsync(500);
    expect(latest().nodes).toHaveProperty("child.title", "child title");

    delete parents.child;
    watch.observe({ method: "thread/deleted", params: { threadId: "child" } }, true);
    await vi.advanceTimersByTimeAsync(500);
    expect(latest().parents).toEqual({});
    expect(latest().nodes).not.toHaveProperty("child");
  } finally {
    watch.close();
    vi.useRealTimers();
  }
});

it("detects archived_sessions created later and resolves symlinked thread paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-tree-watch-"));
  const realHome = path.join(root, "real-home");
  const linkedHome = path.join(root, "linked-home");
  const altHome = path.join(root, "alt-home");
  await mkdir(realHome, { recursive: true });
  await symlink(realHome, linkedHome);
  await symlink(realHome, altHome);
  const send = vi.fn<(message: JsonObject) => Promise<void>>(async () => {});
  let archiveCreated = false;
  const watch = new ThreadTreeWatch({
    codexHome: linkedHome,
    tree: { read: async () => ({ parents: { archived: "parent" } }) },
    repository: { listSummaries: async () => [] },
    events: new ClientChannelEvents(),
    localStatus: () => undefined,
    waiting: () => false,
    readOfficial: async (id) => ({
      result: {
        thread: {
          id,
          status: { type: "notLoaded" },
          path: path.join(archiveCreated ? altHome : realHome, "archived_sessions", `${id}.jsonl`),
        },
      },
    }),
    send,
    diagnose: (error) => {
      throw error;
    },
  });
  try {
    // First watch before archived_sessions exists must not permanently cache null.
    await watch.handle({ id: 1, method: THREAD_TREE_WATCH_METHOD, params: {} });
    expect(
      threadTreeWatchResultSchema.parse(send.mock.lastCall?.[0].result).snapshot.nodes,
    ).toHaveProperty("archived.archived", false);

    await mkdir(path.join(realHome, "archived_sessions"), { recursive: true });
    archiveCreated = true;
    watch.resetOfficial();
    await watch.handle({ id: 2, method: THREAD_TREE_WATCH_METHOD, params: {} });
    expect(
      threadTreeWatchResultSchema.parse(send.mock.lastCall?.[0].result).snapshot.nodes,
    ).toHaveProperty("archived.archived", true);
  } finally {
    watch.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("exposes handoffs and updatedAtMs on demand via readSnapshot and bounds handoff edges", async () => {
  const sourceId = hostThreadIdSchema.parse("official-source");
  const targetId = hostThreadIdSchema.parse("external-target");
  const codex = harnessIdSchema.parse("codex");
  const claude = harnessIdSchema.parse("claude");
  const handoffCreatedAtMs = 1_764_300_000_000;
  const externalUpdatedIso = "2026-11-28T08:00:00.000Z";
  const officialUpdatedSeconds = 1_764_290_000;

  const watch = new ThreadTreeWatch({
    codexHome: path.resolve("fixture-codex-home"),
    tree: { read: async () => ({ parents: {} }) },
    repository: {
      listSummaries: async () => [
        {
          formatVersion: 1,
          state: "ready",
          hostThreadId: targetId,
          harnessId: claude,
          cwd: "/workspace",
          title: "Handed-off task",
          createdAt: externalUpdatedIso,
          updatedAt: externalUpdatedIso,
          archived: false,
          transportModelId: "codexhost/claude",
          ephemeral: false,
          revision: 1,
          historyMode: "paginated",
        },
      ],
      listThreadHandoffs: async () => [
        {
          targetThreadId: targetId,
          handoff: {
            sourceThreadId: sourceId,
            sourceHarnessId: codex,
            targetHarnessId: claude,
            createdAtMs: handoffCreatedAtMs,
          },
        },
      ],
    },
    events: new ClientChannelEvents(),
    localStatus: () => undefined,
    waiting: () => false,
    readOfficial: async (id) => ({
      result: {
        thread: {
          id,
          name: "Original Codex thread",
          status: { type: "idle" },
          updatedAt: officialUpdatedSeconds,
        },
      },
    }),
    send: async () => {},
    diagnose: (error) => {
      throw error;
    },
  });

  try {
    // On-demand readSnapshot must populate official handoff nodes even with zero Desktop watchers.
    const snapshot = threadTreeSnapshotSchema.parse(await watch.readSnapshot());
    expect(snapshot.handoffs).toEqual({
      [targetId]: { sourceThreadId: sourceId, createdAtMs: handoffCreatedAtMs },
    });
    expect(snapshot.nodes[sourceId]).toEqual({
      harnessId: codex,
      title: "Original Codex thread",
      status: "idle",
      archived: false,
      updatedAtMs: officialUpdatedSeconds * 1_000,
    });
    expect(snapshot.nodes[targetId]).toEqual({
      harnessId: claude,
      title: "Handed-off task",
      status: "idle",
      archived: false,
      updatedAtMs: Date.parse(externalUpdatedIso),
    });

    // limitTreeEdges prefers newer handoffs when hitting the 5,000-node cap.
    const parentEdges = Object.fromEntries(
      Array.from({ length: 4997 }, (_, index) => [`child-${index}`, "root"]),
    );
    const bounded = limitTreeEdges(parentEdges, [
      {
        targetThreadId: hostThreadIdSchema.parse("older-target"),
        handoff: {
          sourceThreadId: hostThreadIdSchema.parse("older-source"),
          sourceHarnessId: codex,
          targetHarnessId: claude,
          createdAtMs: 100,
        },
      },
      {
        targetThreadId: hostThreadIdSchema.parse("newer-target"),
        handoff: {
          sourceThreadId: hostThreadIdSchema.parse("newer-source"),
          sourceHarnessId: codex,
          targetHarnessId: claude,
          createdAtMs: 200,
        },
      },
    ]);
    expect(bounded.ids.size).toBe(5000);
    expect(bounded.truncated).toBe(true);
    expect(Object.keys(bounded.handoffs)).toEqual(["newer-target"]);
  } finally {
    watch.close();
  }
});
