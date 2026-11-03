import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DelegationControlError,
  type DelegationThreadSnapshot,
  type DelegationThreadStatus,
  type ThreadSendInput,
} from "../src/delegation-types.js";
import { DelegationWatchService } from "../src/delegation-watch.js";
import type { DelegationWatchStore, PersistedWatch } from "../src/delegation-watch-store.js";

const POLL_MS = 1_000;
const GRACE_MS = 120_000;

/** Records shared by successive Runtimes, as the file store shares a directory. */
function memoryStore(): DelegationWatchStore & { records: Map<string, PersistedWatch> } {
  const records = new Map<string, PersistedWatch>();
  return {
    records,
    adopt: async () => [...records.values()].map((record) => structuredClone(record)),
    save: async (watch) => {
      records.set(watch.id, structuredClone(watch));
    },
    remove: async (id) => {
      records.delete(id);
    },
  };
}

/** A fake Runtime whose Threads are driven by the test; `offline` models sessions not yet registered. */
function runtime(threads: Record<string, { status: DelegationThreadStatus; turnId?: string }>) {
  const sent: ThreadSendInput[] = [];
  const state = { offline: false };
  const read = vi.fn(async ({ threadId }: { threadId: string }) => {
    if (state.offline)
      throw new DelegationControlError(
        "PARENT_THREAD_AMBIGUOUS",
        "Thread is not owned by exactly one active Host Runtime session",
      );
    const thread = threads[threadId];
    if (!thread) throw new DelegationControlError("THREAD_NOT_FOUND", "Thread was not found");
    return {
      threadId,
      harnessId: "pi",
      status: thread.status,
      turn: { turnId: thread.turnId ?? `turn-${threadId}`, status: thread.status },
      progress: [],
      result: { availability: "pending" },
      nextCursor: null,
    } as DelegationThreadSnapshot;
  });
  const send = vi.fn(async (input: ThreadSendInput) => {
    sent.push(input);
    return {
      threadId: input.threadId,
      turnId: "notified-turn",
      harnessId: "codex" as const,
      status: "running" as const,
      next: { read: "read", wait: "wait" },
    };
  });
  const update = (threadId: string, patch: { status: DelegationThreadStatus }) =>
    Object.assign(threads[threadId] ?? {}, patch);
  return { threads, sent, state, read, send, update };
}

function service(
  fake: ReturnType<typeof runtime>,
  store: DelegationWatchStore,
): DelegationWatchService {
  return new DelegationWatchService(fake, {
    pollIntervalMs: POLL_MS,
    restoreGraceMs: GRACE_MS,
    store,
  });
}

describe("DelegationWatchService across a Host Runtime restart", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores a watch while it is pending and removes it once delivered", async () => {
    const store = memoryStore();
    const fake = runtime({ child: { status: "running" }, parent: { status: "completed" } });
    const watches = service(fake, store);
    await watches.watch({ threadId: "child", notifyThreadId: "parent", timeoutMs: 60_000 });
    expect([...store.records.values()]).toMatchObject([
      { threadId: "child", notifyThreadId: "parent", state: "watching", timeoutMs: 60_000 },
    ]);

    fake.update("child", { status: "completed" });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(fake.sent).toHaveLength(1);
    expect(store.records.size).toBe(0);
  });

  it("resumes watching after a restart and notifies once", async () => {
    const store = memoryStore();
    const before = runtime({ child: { status: "running" }, parent: { status: "completed" } });
    const first = service(before, store);
    await first.watch({ threadId: "child", notifyThreadId: "parent", timeoutMs: 60_000 });
    const listed = await first.watches();
    first.close();

    const after = runtime({ child: { status: "running" }, parent: { status: "completed" } });
    const second = service(after, store);
    await expect(second.watches()).resolves.toEqual(listed);

    after.update("child", { status: "completed" });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(after.sent).toHaveLength(1);
    expect(after.sent[0]?.message).toContain("codex://threads/child: completed (Turn turn-child).");
    expect(before.sent).toEqual([]);
    expect(store.records.size).toBe(0);
  });

  it("reports the terminal state reached during downtime rather than timedOut", async () => {
    const store = memoryStore();
    const first = service(
      runtime({ child: { status: "running" }, parent: { status: "completed" } }),
      store,
    );
    await first.watch({ threadId: "child", notifyThreadId: "parent", timeoutMs: 10_000 });
    first.close();

    // The Runtime stays down past the watch deadline; the child finishes meanwhile.
    vi.setSystemTime(Date.now() + 60_000);
    const after = runtime({ child: { status: "failed" }, parent: { status: "completed" } });
    service(after, store);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(after.sent[0]?.message).toContain("codex://threads/child: failed");
  });

  it("reports timedOut when the deadline passed during downtime and the Thread still runs", async () => {
    const store = memoryStore();
    const first = service(
      runtime({ child: { status: "running" }, parent: { status: "completed" } }),
      store,
    );
    await first.watch({ threadId: "child", notifyThreadId: "parent", timeoutMs: 10_000 });
    first.close();

    vi.setSystemTime(Date.now() + 60_000);
    const after = runtime({ child: { status: "running" }, parent: { status: "completed" } });
    service(after, store);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(after.sent[0]?.message).toContain("has not reached a terminal state after 10 s");
  });

  it("does not count reads before the sessions register again toward unreadable", async () => {
    const store = memoryStore();
    const first = service(
      runtime({ child: { status: "running" }, parent: { status: "completed" } }),
      store,
    );
    await first.watch({ threadId: "child", notifyThreadId: "parent", timeoutMs: 60 * 60_000 });
    first.close();

    const after = runtime({ child: { status: "running" }, parent: { status: "completed" } });
    after.state.offline = true;
    service(after, store);
    // Longer than the 60 s unreadable window, but within the restore grace.
    await vi.advanceTimersByTimeAsync(90_000);
    expect(after.sent).toEqual([]);

    after.state.offline = false;
    after.update("child", { status: "completed" });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(after.sent).toHaveLength(1);
    expect(after.sent[0]?.message).toContain("completed");
  });

  it("starts the unreadable window once the restore grace ends", async () => {
    const store = memoryStore();
    const first = service(
      runtime({ child: { status: "running" }, parent: { status: "completed" } }),
      store,
    );
    await first.watch({ threadId: "child", notifyThreadId: "parent", timeoutMs: 60 * 60_000 });
    first.close();

    const after = runtime({ child: { status: "running" }, parent: { status: "completed" } });
    after.state.offline = true;
    const second = service(after, store);
    await vi.advanceTimersByTimeAsync(GRACE_MS + 59_000);
    expect(after.sent).toEqual([]);
    // The session for the notified Thread is back; the watched one is still unreadable.
    after.read.mockImplementation(async ({ threadId }: { threadId: string }) => {
      if (threadId === "child") throw new DelegationControlError("INTERNAL_ERROR", "gone");
      return { threadId, harnessId: "pi", status: "completed" } as DelegationThreadSnapshot;
    });
    await vi.advanceTimersByTimeAsync(3 * POLL_MS);
    expect(after.sent).toHaveLength(1);
    expect(after.sent[0]?.message).toContain("could not be read for 60 s");
    await expect(second.watches()).resolves.toEqual({ watches: [] });
  });

  it("delivers again a notification whose send was interrupted by the restart", async () => {
    const store = memoryStore();
    const before = runtime({ child: { status: "running" }, parent: { status: "completed" } });
    // The send never settles: the Runtime exits while it is in flight.
    before.send.mockImplementation(() => new Promise(() => undefined));
    const first = service(before, store);
    await first.watch({ threadId: "child", notifyThreadId: "parent", timeoutMs: 60_000 });
    before.update("child", { status: "completed" });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(before.send).toHaveBeenCalledOnce();
    expect([...store.records.values()]).toMatchObject([
      { state: "pendingDelivery", outcome: "completed", delivering: true },
    ]);
    first.close();

    const after = runtime({ child: { status: "completed" }, parent: { status: "completed" } });
    service(after, store);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(after.sent).toHaveLength(1);
    expect(after.sent[0]?.message).toContain("codex://threads/child: completed");
    expect(store.records.size).toBe(0);
  });

  it("holds a restored notification until the notified Thread is reachable", async () => {
    const store = memoryStore();
    const before = runtime({ child: { status: "running" }, parent: { status: "running" } });
    before.send.mockRejectedValue(new DelegationControlError("THREAD_BUSY", "busy"));
    const first = service(before, store);
    await first.watch({ threadId: "child", notifyThreadId: "parent", timeoutMs: 60_000 });
    before.update("child", { status: "completed" });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    first.close();

    const after = runtime({ child: { status: "completed" }, parent: { status: "completed" } });
    after.state.offline = true;
    const second = service(after, store);
    await vi.advanceTimersByTimeAsync(5 * POLL_MS);
    expect(after.send).not.toHaveBeenCalled();
    await expect(second.watches()).resolves.toMatchObject({
      watches: [{ state: "pendingDelivery", outcome: "completed" }],
    });

    after.state.offline = false;
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(after.sent).toHaveLength(1);
  });

  it("marks a notification undeliverable when its delivery window ended during downtime", async () => {
    const store = memoryStore();
    const before = runtime({ child: { status: "running" }, parent: { status: "running" } });
    before.send.mockRejectedValue(new DelegationControlError("THREAD_BUSY", "busy"));
    const first = service(before, store);
    await first.watch({ threadId: "child", notifyThreadId: "parent", timeoutMs: 60_000 });
    before.update("child", { status: "completed" });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    first.close();

    vi.setSystemTime(Date.now() + 7 * 60 * 60_000);
    const after = runtime({ child: { status: "completed" }, parent: { status: "completed" } });
    const second = service(after, store);
    await expect(second.watches()).resolves.toMatchObject({
      watches: [
        { state: "undeliverable", reason: expect.stringContaining("Host Runtime was stopped") },
      ],
    });
    await vi.advanceTimersByTimeAsync(5 * POLL_MS);
    expect(after.send).not.toHaveBeenCalled();
    expect([...store.records.values()]).toMatchObject([{ state: "undeliverable" }]);
  });

  it("keeps a send with an unknown outcome undeliverable across a restart", async () => {
    const store = memoryStore();
    const before = runtime({ child: { status: "running" }, parent: { status: "completed" } });
    before.send.mockRejectedValue(new Error("Official app-server request timed out"));
    const first = service(before, store);
    await first.watch({ threadId: "child", notifyThreadId: "parent", timeoutMs: 60_000 });
    before.update("child", { status: "completed" });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    first.close();

    const after = runtime({ child: { status: "completed" }, parent: { status: "completed" } });
    const second = service(after, store);
    await vi.advanceTimersByTimeAsync(5 * POLL_MS);
    expect(after.send).not.toHaveBeenCalled();
    await expect(second.watches()).resolves.toMatchObject({
      watches: [
        { state: "undeliverable", reason: expect.stringContaining("Delivery outcome unknown") },
      ],
    });
  });

  it("keeps working in memory when the store fails", async () => {
    const diagnose = vi.fn();
    const failing: DelegationWatchStore = {
      adopt: async () => {
        throw new Error("disk unavailable");
      },
      save: async () => {
        throw new Error("disk full");
      },
      remove: async () => undefined,
    };
    const fake = runtime({ child: { status: "running" }, parent: { status: "completed" } });
    const watches = new DelegationWatchService(fake, {
      pollIntervalMs: POLL_MS,
      store: failing,
      diagnose,
    });
    await expect(
      watches.watch({ threadId: "child", notifyThreadId: "parent", timeoutMs: 60_000 }),
    ).resolves.toMatchObject({ state: "watching" });
    fake.update("child", { status: "completed" });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(fake.sent).toHaveLength(1);
    expect(diagnose).toHaveBeenCalled();
  });
});
