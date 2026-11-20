import type { JsonObject } from "@codexhost/protocol-core";
import {
  THREAD_TREE_SNAPSHOT_METHOD,
  THREAD_TREE_WATCH_METHOD,
  threadTreeWatchResultSchema,
} from "@codexhost/shared-contracts";
import { expect, it, vi } from "vitest";
import { ClientChannelEvents } from "../src/client-channel-events.js";
import { ThreadTreeWatch } from "../src/thread-tree-watch.js";

it("reprobes official threads on reconnect and ignores reads from the retired generation", async () => {
  vi.useFakeTimers();
  const stale = Promise.withResolvers<JsonObject>();
  const send = vi.fn<(message: JsonObject) => Promise<void>>(async () => {});
  const officialThread = (name: string, type: string): JsonObject => ({
    result: { thread: { id: "official", name, status: { type } } },
  });
  let reconnected = false;
  const watch = new ThreadTreeWatch({
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
