import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DelegationControlError,
  type DelegationThreadSnapshot,
  type DelegationThreadStatus,
  type ThreadSendInput,
} from "../src/delegation-types.js";
import { DelegationWatchService } from "../src/delegation-watch.js";

const POLL_MS = 1_000;

/** A fake Runtime whose Threads are driven by the test. */
function runtime(threads: Record<string, { status: DelegationThreadStatus; turnId?: string }>) {
  const sent: ThreadSendInput[] = [];
  const sendFailures: DelegationControlError[] = [];
  const readFailure: { current?: DelegationControlError } = {};
  const read = vi.fn(async ({ threadId }: { threadId: string }) => {
    if (readFailure.current) throw readFailure.current;
    const thread = threads[threadId];
    if (!thread) throw new DelegationControlError("THREAD_NOT_FOUND", "Thread was not found");
    const turnId = thread.turnId ?? `turn-${threadId}`;
    return {
      threadId,
      harnessId: "pi",
      status: thread.status,
      turn: { turnId, status: thread.status },
      progress: [],
      result: { availability: "pending" },
      nextCursor: null,
    } as DelegationThreadSnapshot;
  });
  const send = vi.fn(async (input: ThreadSendInput) => {
    const failure = sendFailures.shift();
    if (failure) throw failure;
    sent.push(input);
    return {
      threadId: input.threadId,
      turnId: "notified-turn",
      harnessId: "codex" as const,
      status: "running" as const,
      next: { read: "read", wait: "wait" },
    };
  });
  const update = (threadId: string, patch: { status?: DelegationThreadStatus; turnId?: string }) =>
    Object.assign(threads[threadId] ?? {}, patch);
  return { threads, sent, sendFailures, readFailure, read, send, update };
}

const busy = () => new DelegationControlError("THREAD_BUSY", "Thread already has an active Turn");

describe("DelegationWatchService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["completed", "failed", "interrupted"] as const)(
    "notifies the subscriber once when the watched Turn is %s",
    async (status) => {
      const fake = runtime({ child: { status: "running" }, parent: { status: "completed" } });
      const service = new DelegationWatchService(fake, { pollIntervalMs: POLL_MS });
      await expect(
        service.watch({ threadId: "child", notifyThreadId: "parent", timeoutMs: 60_000 }),
      ).resolves.toMatchObject({ state: "watching", status: "running" });

      await vi.advanceTimersByTimeAsync(POLL_MS);
      expect(fake.sent).toEqual([]);

      fake.update("child", { status: status });
      await vi.advanceTimersByTimeAsync(POLL_MS);
      expect(fake.sent).toHaveLength(1);
      expect(fake.sent[0]?.threadId).toBe("parent");
      expect(fake.sent[0]?.message).toContain(`codex://threads/child: ${status}.`);
      expect(fake.sent[0]?.message).toContain("execution state only");

      // The terminal state stays readable, but the one-shot watch is gone.
      await vi.advanceTimersByTimeAsync(POLL_MS * 10);
      expect(fake.sent).toHaveLength(1);
      await expect(service.watches()).resolves.toEqual({ watches: [] });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("keeps a notification pending while the subscriber is busy", async () => {
    const fake = runtime({ child: { status: "running" }, parent: { status: "running" } });
    const service = new DelegationWatchService(fake, { pollIntervalMs: POLL_MS });
    await service.watch({ threadId: "child", notifyThreadId: "parent", timeoutMs: 60_000 });
    fake.update("child", { status: "completed" });
    fake.sendFailures.push(busy(), busy());

    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(fake.sent).toEqual([]);
    await expect(service.watches()).resolves.toMatchObject({
      watches: [{ threadId: "child", state: "pendingDelivery", outcome: "completed" }],
    });

    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(fake.sent).toHaveLength(1);
    await expect(service.watches()).resolves.toEqual({ watches: [] });
  });

  it("does not register a watch for a Thread that is not running", async () => {
    const fake = runtime({ child: { status: "failed" }, parent: { status: "completed" } });
    const service = new DelegationWatchService(fake, { pollIntervalMs: POLL_MS });
    await expect(
      service.watch({ threadId: "child", notifyThreadId: "parent", timeoutMs: 60_000 }),
    ).resolves.toMatchObject({ state: "alreadyTerminal", status: "failed" });
    await vi.advanceTimersByTimeAsync(POLL_MS * 5);
    expect(fake.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports timedOut when the Thread never reaches a terminal state", async () => {
    const fake = runtime({ child: { status: "running" }, parent: { status: "completed" } });
    const service = new DelegationWatchService(fake, { pollIntervalMs: POLL_MS });
    await service.watch({ threadId: "child", notifyThreadId: "parent", timeoutMs: 29 * 60_000 });

    await vi.advanceTimersByTimeAsync(28 * 60_000);
    expect(fake.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000 + POLL_MS);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.message).toContain("has not reached a terminal state after 29 min");
  });

  it("states a timeout shorter than a minute in seconds", async () => {
    const fake = runtime({ child: { status: "running" }, parent: { status: "completed" } });
    const service = new DelegationWatchService(fake, { pollIntervalMs: POLL_MS });
    await service.watch({ threadId: "child", notifyThreadId: "parent", timeoutMs: 15_000 });

    await vi.advanceTimersByTimeAsync(15_000 + POLL_MS);
    expect(fake.sent[0]?.message).toContain("has not reached a terminal state after 15 s");
  });

  it("waits out a replacement Turn and notifies once when the Thread stops", async () => {
    const fake = runtime({
      child: { status: "running", turnId: "turn-1" },
      parent: { status: "completed" },
    });
    const service = new DelegationWatchService(fake, { pollIntervalMs: POLL_MS });
    await service.watch({ threadId: "child", notifyThreadId: "parent", timeoutMs: 60_000 });
    fake.update("child", { turnId: "turn-2" });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(fake.sent).toEqual([]);

    fake.update("child", { status: "completed" });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.message).toContain("codex://threads/child: completed.");
  });

  it("notifies once when the same pair is registered again for a new Turn", async () => {
    const fake = runtime({
      child: { status: "running", turnId: "turn-1" },
      parent: { status: "completed" },
    });
    const service = new DelegationWatchService(fake, { pollIntervalMs: POLL_MS });
    await service.watch({ threadId: "child", notifyThreadId: "parent", timeoutMs: 60_000 });
    fake.update("child", { turnId: "turn-2" });
    await expect(
      service.watch({ threadId: "child", notifyThreadId: "parent", timeoutMs: 5_000 }),
    ).resolves.toMatchObject({ state: "watching", status: "running", timeoutMs: 60_000 });
    await expect(service.watches()).resolves.toMatchObject({
      watches: [{ threadId: "child", notifyThreadId: "parent", state: "watching" }],
    });

    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(fake.sent).toEqual([]);
    fake.update("child", { status: "completed" });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.message).toContain("codex://threads/child: completed.");
  });

  it("merges notifications due together for one subscriber into one Turn", async () => {
    const fake = runtime({
      a: { status: "running" },
      b: { status: "running" },
      parent: { status: "completed" },
    });
    const service = new DelegationWatchService(fake, { pollIntervalMs: POLL_MS });
    await service.watch({ threadId: "a", notifyThreadId: "parent", timeoutMs: 60_000 });
    await service.watch({ threadId: "b", notifyThreadId: "parent", timeoutMs: 60_000 });
    fake.update("a", { status: "completed" });
    fake.update("b", { status: "failed" });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.message).toContain("codex://threads/a: completed.");
    expect(fake.sent[0]?.message).toContain("codex://threads/b: failed.");
  });

  it("treats a repeated registration as the same watch", async () => {
    const fake = runtime({ child: { status: "running" }, parent: { status: "completed" } });
    const service = new DelegationWatchService(fake, { pollIntervalMs: POLL_MS });
    await service.watch({ threadId: "child", notifyThreadId: "parent", timeoutMs: 60_000 });
    await expect(
      service.watch({ threadId: "child", notifyThreadId: "parent", timeoutMs: 5_000 }),
    ).resolves.toMatchObject({ state: "watching", timeoutMs: 60_000 });
    await expect(service.watches()).resolves.toMatchObject({ watches: [{ threadId: "child" }] });
    fake.update("child", { status: "completed" });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(fake.sent).toHaveLength(1);
  });

  it("rejects a watch whose target or subscriber does not exist", async () => {
    const fake = runtime({ child: { status: "running" } });
    const service = new DelegationWatchService(fake, { pollIntervalMs: POLL_MS });
    await expect(
      service.watch({ threadId: "missing", notifyThreadId: "child", timeoutMs: 60_000 }),
    ).rejects.toMatchObject({ code: "THREAD_NOT_FOUND" });
    await expect(
      service.watch({ threadId: "child", notifyThreadId: "missing", timeoutMs: 60_000 }),
    ).rejects.toMatchObject({ code: "THREAD_NOT_FOUND" });
    await expect(
      service.watch({ threadId: "child", notifyThreadId: "child", timeoutMs: 60_000 }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      service.watch({ threadId: "child", notifyThreadId: "other", timeoutMs: 0 }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(service.watches()).resolves.toEqual({ watches: [] });
  });

  it("keeps an undeliverable notification visible instead of reporting delivery", async () => {
    const fake = runtime({ child: { status: "running" }, parent: { status: "completed" } });
    const service = new DelegationWatchService(fake, { pollIntervalMs: POLL_MS });
    await service.watch({ threadId: "child", notifyThreadId: "parent", timeoutMs: 60_000 });
    fake.update("child", { status: "completed" });
    fake.sendFailures.push(new DelegationControlError("DELEGATION_FAILED", "Thread is read-only"));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await expect(service.watches()).resolves.toMatchObject({
      watches: [{ state: "undeliverable", outcome: "completed", reason: "Thread is read-only" }],
    });
    // Nothing left to poll or retry.
    expect(vi.getTimerCount()).toBe(0);
    expect(fake.sent).toEqual([]);
  });

  it("reports a watched Thread that was deleted", async () => {
    const fake = runtime({ child: { status: "running" }, parent: { status: "completed" } });
    const service = new DelegationWatchService(fake, { pollIntervalMs: POLL_MS });
    await service.watch({ threadId: "child", notifyThreadId: "parent", timeoutMs: 60_000 });
    delete fake.threads.child;
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(fake.sent[0]?.message).toContain("codex://threads/child no longer exists.");
  });

  it("reports unreadable only after reads keep failing", async () => {
    const fake = runtime({ child: { status: "running" }, parent: { status: "completed" } });
    const service = new DelegationWatchService(fake, { pollIntervalMs: POLL_MS });
    await service.watch({ threadId: "child", notifyThreadId: "parent", timeoutMs: 29 * 60_000 });

    // A short outage is not reported.
    fake.readFailure.current = new DelegationControlError("INTERNAL_ERROR", "read failed");
    await vi.advanceTimersByTimeAsync(30_000);
    delete fake.readFailure.current;
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(fake.sent).toEqual([]);

    fake.readFailure.current = new DelegationControlError("INTERNAL_ERROR", "Harness is gone");
    await vi.advanceTimersByTimeAsync(59_000);
    expect(fake.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.message).toContain("could not be read for 60 s");
    expect(fake.sent[0]?.message).toContain("Harness is gone");
  });

  it("retries delivery after send throws synchronously", async () => {
    const fake = runtime({ child: { status: "running" }, parent: { status: "completed" } });
    const service = new DelegationWatchService(fake, { pollIntervalMs: POLL_MS });
    await service.watch({ threadId: "child", notifyThreadId: "parent", timeoutMs: 60_000 });
    const send = fake.send.getMockImplementation();
    fake.update("child", { status: "completed" });
    fake.send.mockImplementationOnce(() => {
      throw new TypeError("synthetic bug");
    });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(fake.sent).toEqual([]);

    if (send) fake.send.mockImplementation(send);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(fake.sent).toHaveLength(1);
  });

  it("stops all work when closed", async () => {
    const fake = runtime({ child: { status: "running" }, parent: { status: "completed" } });
    const service = new DelegationWatchService(fake, { pollIntervalMs: POLL_MS });
    await service.watch({ threadId: "child", notifyThreadId: "parent", timeoutMs: 60_000 });
    service.close();
    fake.update("child", { status: "completed" });
    await vi.advanceTimersByTimeAsync(POLL_MS * 5);
    expect(fake.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await expect(
      service.watch({ threadId: "child", notifyThreadId: "parent", timeoutMs: 60_000 }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });
});
