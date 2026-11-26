import type { JsonObject } from "@codexhost/protocol-core";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  THREAD_TREE_SNAPSHOT_METHOD,
  THREAD_TREE_WATCH_METHOD,
  threadTreeWatchResultSchema,
} from "@codexhost/shared-contracts";
import { expect, it, vi } from "vitest";
import { ClientChannelEvents } from "../src/client-channel-events.js";
import { ThreadTreeWatch } from "../src/thread-tree-watch.js";

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
      threadTreeWatchResultSchema.parse(send.mock.lastCall?.[0].result).snapshot.nodes.archived
        ?.archived,
    ).toBe(false);

    await mkdir(path.join(realHome, "archived_sessions"), { recursive: true });
    archiveCreated = true;
    watch.resetOfficial();
    await watch.handle({ id: 2, method: THREAD_TREE_WATCH_METHOD, params: {} });
    expect(
      threadTreeWatchResultSchema.parse(send.mock.lastCall?.[0].result).snapshot.nodes.archived
        ?.archived,
    ).toBe(true);
  } finally {
    watch.close();
    await rm(root, { recursive: true, force: true });
  }
});
