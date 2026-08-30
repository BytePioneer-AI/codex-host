import { describe, expect, it, vi } from "vitest";

import { DelegationControlRegistry } from "../src/delegation-control-registry.js";
import type { DelegationControlRegistration } from "../src/delegation-types.js";

function registration(threadId: string): DelegationControlRegistration {
  return {
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
  it("routes explicit parent and Thread operations to the owning Host session", async () => {
    const registry = new DelegationControlRegistry();
    const first = registration("parent-a");
    const second = registration("parent-b");
    registry.register(first);
    registry.register(second);

    await registry.start({
      harnessId: "pi" as const,
      task: "review",
      cwd: "/synthetic",
      parentThreadId: "parent-b",
    });
    await registry.read({ threadId: "parent-a", view: "result" });

    expect(second.start).toHaveBeenCalledOnce();
    expect(first.read).toHaveBeenCalledOnce();
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
});
