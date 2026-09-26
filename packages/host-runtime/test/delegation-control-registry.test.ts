import { describe, expect, it, vi } from "vitest";

import { DelegationControlRegistry } from "../src/delegation-control-registry.js";
import type { DelegationControlRegistration } from "../src/delegation-types.js";

function registration(threadId: string): DelegationControlRegistration {
  return {
    listHarnesses: vi.fn(async () => ({ harnesses: ["codex" as const, "pi" as const] })),
    inspect: vi.fn(async (input) => ({
      harnessId: input.harnessId,
      inspection: {
        status: "ready" as const,
        catalog: { models: [], thinkingOptions: [] },
        capabilities: {
          configuration: {
            selectModel: false,
            selectThinkingOption: false,
            selectPermissionMode: false,
            permissionModeScope: "live" as const,
          },
          history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
        },
      },
    })),
    canHandleStart: (input) => input.parentThreadId === threadId,
    ownsThread: (candidate) => candidate === threadId,
    start: vi.fn(async () => ({
      delegationId: `delegation-${threadId}`,
      threadId: `child-${threadId}`,
      turnId: `turn-${threadId}`,
      harnessId: "pi" as const,
      deepLink: `codex://threads/child-${threadId}`,
      status: "running" as const,
      next: { read: "read", wait: "wait" },
    })),
    send: vi.fn(async () => ({
      threadId,
      turnId: `turn-${threadId}`,
      harnessId: "pi" as const,
      status: "running" as const,
      next: { read: "read", wait: "wait" },
    })),
    cancel: vi.fn(async () => ({
      threadId,
      turnId: null,
      harnessId: "pi" as const,
      cancelled: false,
    })),
    read: vi.fn(async () => ({
      threadId,
      harnessId: "pi" as const,
      status: "running" as const,
      turn: null,
      progress: [],
      result: { availability: "pending" as const },
      messages: [],
      nextCursor: null,
    })),
    wait: vi.fn(async () => ({
      threadId,
      harnessId: "pi" as const,
      status: "running" as const,
      turn: null,
      progress: [],
      result: { availability: "pending" as const },
      messages: [],
      nextCursor: null,
      timedOut: true,
    })),
    list: vi.fn(async () => ({ threads: [], nextCursor: null })),
  };
}

describe("DelegationControlRegistry", () => {
  it("discovers targets from the active session without inspecting Models", async () => {
    const registry = new DelegationControlRegistry();
    const session = registration("parent");
    registry.register(session);
    await expect(registry.listHarnesses()).resolves.toEqual({ harnesses: ["codex", "pi"] });
    expect(session.inspect).not.toHaveBeenCalled();
    registry.register(registration("another-parent"));
    await expect(registry.listHarnesses()).rejects.toMatchObject({
      code: "PARENT_THREAD_AMBIGUOUS",
    });
  });
  it("routes explicit parent and Thread operations to the owning Host session", async () => {
    const registry = new DelegationControlRegistry();
    const first = registration("parent-a");
    const second = registration("parent-b");
    registry.register(first);
    registry.register(second);

    await expect(registry.inspect({ harnessId: "pi" })).rejects.toMatchObject({
      code: "PARENT_THREAD_AMBIGUOUS",
    });
    await registry.start({
      harnessId: "pi" as const,
      task: "review",
      cwd: "/synthetic",
      parentThreadId: "parent-b",
    });
    await registry.read({ threadId: "parent-a", view: "result" });
    await registry.send({ threadId: "parent-b", message: "continue" });
    await registry.cancel({ threadId: "parent-a" });

    expect(second.start).toHaveBeenCalledOnce();
    expect(first.read).toHaveBeenCalledOnce();
    expect(second.send).toHaveBeenCalledOnce();
    expect(first.cancel).toHaveBeenCalledOnce();
  });

  it("requires a unique active session for implicit start and unscoped list", async () => {
    const registry = new DelegationControlRegistry();
    registry.register(registration("parent-a"));
    registry.register(registration("parent-b"));

    await expect(
      registry.start({ harnessId: "pi" as const, task: "review", cwd: "/synthetic" }),
    ).rejects.toMatchObject({ code: "PARENT_THREAD_AMBIGUOUS" });
    await expect(
      registry.list({ cwd: "/synthetic", limit: 25, sort: "created-desc" }),
    ).resolves.toEqual({ threads: [], nextCursor: null });
  });

  it("unregisters closed Host sessions", async () => {
    const registry = new DelegationControlRegistry();
    const unregister = registry.register(registration("parent-a"));
    expect(registry.size).toBe(1);
    unregister();
    expect(registry.size).toBe(0);
    await expect(registry.read({ threadId: "parent-a", view: "result" })).rejects.toMatchObject({
      code: "PARENT_THREAD_AMBIGUOUS",
    });
  });

  it("watches a Thread in one session and notifies a Thread in another", async () => {
    vi.useFakeTimers();
    try {
      const registry = new DelegationControlRegistry();
      const watched = registration("child");
      const subscriber = registration("parent");
      registry.register(watched);
      registry.register(subscriber);
      await expect(
        registry.watch({ threadId: "child", notifyThreadId: "parent", timeoutMs: 60_000 }),
      ).resolves.toMatchObject({ state: "watching" });

      vi.mocked(watched.read).mockResolvedValue({
        threadId: "child",
        harnessId: "pi",
        status: "completed",
        turn: null,
        progress: [],
        result: { availability: "available", text: "done" },
        nextCursor: null,
      });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(subscriber.send).toHaveBeenCalledTimes(1);
      expect(vi.mocked(subscriber.send).mock.calls[0]?.[0]).toMatchObject({ threadId: "parent" });
      expect(watched.send).not.toHaveBeenCalled();

      // Closing drops remaining watches with the Host Runtime.
      await registry.watch({ threadId: "parent", notifyThreadId: "child", timeoutMs: 60_000 });
      registry.close();
      await expect(registry.watches()).resolves.toEqual({ watches: [] });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("infers the notified Thread only when exactly one other Thread is active", async () => {
    vi.useFakeTimers();
    try {
      const registry = new DelegationControlRegistry();
      const session = registration("child");
      session.ownsThread = () => true;
      const active = vi.fn(() => ["child", "caller"]);
      session.activeThreadIds = active;
      registry.register(session);

      await expect(registry.watch({ threadId: "child", timeoutMs: 60_000 })).resolves.toMatchObject(
        { state: "watching", notifyThreadId: "caller" },
      );

      active.mockReturnValue(["child"]);
      await expect(registry.watch({ threadId: "child", timeoutMs: 60_000 })).rejects.toMatchObject({
        code: "PARENT_THREAD_AMBIGUOUS",
        details: { activeThreadIds: [] },
      });
      active.mockReturnValue(["child", "caller", "other"]);
      await expect(registry.watch({ threadId: "child", timeoutMs: 60_000 })).rejects.toMatchObject({
        code: "PARENT_THREAD_AMBIGUOUS",
        details: { activeThreadIds: ["caller", "other"] },
      });
      // An explicit notified Thread never needs inference.
      await expect(
        registry.watch({ threadId: "child", notifyThreadId: "other", timeoutMs: 60_000 }),
      ).resolves.toMatchObject({ notifyThreadId: "other" });
      registry.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
