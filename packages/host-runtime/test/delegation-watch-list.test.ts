import { afterEach, describe, expect, it, vi } from "vitest";

import { DelegationWatchService } from "../src/delegation-watch.js";
import type { DelegationThreadSnapshot } from "../src/delegation-types.js";
import type { DelegationWatchStore } from "../src/delegation-watch-store.js";

function runtime() {
  const target: DelegationThreadSnapshot = {
    threadId: "child",
    harnessId: "pi",
    title: '任务 "中文"',
    status: "running",
    turn: null,
    progress: [],
    result: { availability: "pending" },
    nextCursor: null,
  };
  const read = vi.fn(async () => target);
  const send = vi.fn();
  return { target, read, send };
}

afterEach(() => vi.useRealTimers());

describe("watch list metadata", () => {
  it("reads current titles/status once per target and measures time since original registration", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const api = runtime();
    const service = new DelegationWatchService(api);
    try {
      await service.watch({ threadId: "child", notifyThreadId: "parent", timeoutMs: 60_000 });
      await service.watch({ threadId: "child", notifyThreadId: "other", timeoutMs: 60_000 });
      vi.setSystemTime(new Date("2026-01-01T00:00:02.500Z"));
      await service.watch({ threadId: "child", notifyThreadId: "parent", timeoutMs: 60_000 });
      api.target.status = "completed";
      api.target.title = "最新任务名";
      api.read.mockClear();
      const result = await service.watches();
      expect(result).toEqual({
        watches: ["parent", "other"].map((notifyThreadId) => ({
          threadId: "child",
          notifyThreadId,
          state: "watching",
          registeredAt: "2026-01-01T00:00:00.000Z",
          taskName: "最新任务名",
          threadStatus: "completed",
          watchedForMs: 2500,
        })),
      });
      expect(api.read).toHaveBeenCalledExactlyOnceWith({ threadId: "child", view: "result" });
      expect(api.send).not.toHaveBeenCalled();
    } finally {
      service.close();
    }
  });

  it("keeps unreadable watches and cached task names without claiming a current status", async () => {
    const api = runtime();
    const service = new DelegationWatchService(api);
    try {
      await service.watch({ threadId: "child", notifyThreadId: "parent", timeoutMs: 60_000 });
      api.read.mockRejectedValue(new Error("Thread no longer exists"));
      const { watches } = await service.watches();
      expect(watches).toHaveLength(1);
      expect(watches[0]).toMatchObject({
        state: "watching",
        taskName: '任务 "中文"',
        watchedForMs: expect.any(Number),
      });
      expect(watches[0]).not.toHaveProperty("threadStatus");
    } finally {
      service.close();
    }
  });

  it("counts downtime for restored watches and does not confuse watch outcome with current status", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:01:00Z"));
    const store: DelegationWatchStore = {
      adopt: async () => [
        {
          id: "watch",
          threadId: "child",
          notifyThreadId: "parent",
          state: "undeliverable",
          outcome: "completed",
          reason: "unreachable subscriber",
          title: "保存的任务名",
          registeredAt: "2026-01-01T00:00:00.000Z",
          timeoutMs: 30_000,
          deadline: 0,
        },
      ],
      save: vi.fn(),
      remove: vi.fn(),
    };
    const api = runtime();
    delete api.target.title;
    const service = new DelegationWatchService(api, { store });
    try {
      expect(await service.watches()).toEqual({
        watches: [
          {
            threadId: "child",
            notifyThreadId: "parent",
            state: "undeliverable",
            outcome: "completed",
            reason: "unreachable subscriber",
            registeredAt: "2026-01-01T00:00:00.000Z",
            taskName: "保存的任务名",
            threadStatus: "running",
            watchedForMs: 60_000,
          },
        ],
      });
      expect(store.save).not.toHaveBeenCalled();
    } finally {
      service.close();
    }
  });

  it("omits unknown titles and clamps elapsed time if the clock moves backwards", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:01:00Z"));
    const api = runtime();
    delete api.target.title;
    const service = new DelegationWatchService(api);
    try {
      await service.watch({ threadId: "child", notifyThreadId: "parent", timeoutMs: 60_000 });
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const { watches } = await service.watches();
      expect(watches[0]).toMatchObject({ threadStatus: "running", watchedForMs: 0 });
      expect(watches[0]).not.toHaveProperty("taskName");
    } finally {
      service.close();
    }
  });
});
