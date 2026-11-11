import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DelegationControlError,
  type DelegationThreadSnapshot,
  type DelegationThreadStatus,
  type ThreadSendInput,
} from "../src/delegation-types.js";
import { DelegationWatchService } from "../src/delegation-watch.js";
import { ThreadActivity } from "../src/thread-activity.js";

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
      expect(fake.sent[0]?.message).toContain(
        `codex://threads/child: ${status} (Turn turn-child).`,
      );
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

  it.each([
    [15_000, "15 s"],
    [700, "1 s"],
  ])("states a %i ms timeout in whole seconds", async (timeoutMs, text) => {
    const fake = runtime({ child: { status: "running" }, parent: { status: "completed" } });
    const service = new DelegationWatchService(fake, { pollIntervalMs: POLL_MS });
    await service.watch({ threadId: "child", notifyThreadId: "parent", timeoutMs });

    await vi.advanceTimersByTimeAsync(timeoutMs + POLL_MS);
    expect(fake.sent[0]?.message).toContain(`has not reached a terminal state after ${text};`);
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
    expect(fake.sent[0]?.message).toContain("codex://threads/child: completed (Turn turn-2).");
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
    expect(fake.sent[0]?.message).toContain("codex://threads/child: completed (Turn turn-2).");
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
    expect(fake.sent[0]?.message).toContain("codex://threads/a: completed (Turn turn-a).");
    expect(fake.sent[0]?.message).toContain("codex://threads/b: failed (Turn turn-b).");
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

  it("delivers each registration when the pair is watched again after a stop", async () => {
    const fake = runtime({
      child: { status: "running", turnId: "turn-1" },
      parent: { status: "running" },
    });
    const service = new DelegationWatchService(fake, { pollIntervalMs: POLL_MS });
    await service.watch({ threadId: "child", notifyThreadId: "parent", timeoutMs: 60_000 });
    fake.update("child", { status: "failed" });
    fake.sendFailures.push(busy());
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await expect(service.watches()).resolves.toMatchObject({
      watches: [{ state: "pendingDelivery", outcome: "failed", turnId: "turn-1" }],
    });

    // A new run starts while the first notification still waits for the busy subscriber.
    fake.update("child", { status: "running", turnId: "turn-2" });
    fake.sendFailures.push(busy());
    await expect(
      service.watch({ threadId: "child", notifyThreadId: "parent", timeoutMs: 60_000 }),
    ).resolves.toMatchObject({ state: "watching" });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await expect(service.watches()).resolves.toMatchObject({
      watches: [
        { state: "pendingDelivery", outcome: "failed", turnId: "turn-1" },
        { state: "watching" },
      ],
    });

    fake.update("child", { status: "completed" });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    // Both stops arrive in one message and name their Turns; neither replaces the other.
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.message).toContain("codex://threads/child: failed (Turn turn-1).");
    expect(fake.sent[0]?.message).toContain("codex://threads/child: completed (Turn turn-2).");
    await expect(service.watches()).resolves.toEqual({ watches: [] });
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
    await expect(
      service.watch({ threadId: "child", notifyThreadId: "", timeoutMs: 60_000 }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: expect.stringContaining("--notify"),
    });
    await expect(service.watches()).resolves.toEqual({ watches: [] });
  });

  it("keeps an undeliverable notification visible instead of reporting delivery", async () => {
    const fake = runtime({ child: { status: "running" }, parent: { status: "completed" } });
    const service = new DelegationWatchService(fake, { pollIntervalMs: POLL_MS });
    await service.watch({ threadId: "child", notifyThreadId: "parent", timeoutMs: 60_000 });
    fake.update("child", { status: "completed" });
    fake.sendFailures.push(
      new DelegationControlError("DELEGATION_FAILED", "Thread is read-only", { readOnly: true }),
    );
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

  it("retries a send the Host rejected before starting a Turn", async () => {
    const fake = runtime({ child: { status: "running" }, parent: { status: "completed" } });
    const service = new DelegationWatchService(fake, { pollIntervalMs: POLL_MS });
    await service.watch({ threadId: "child", notifyThreadId: "parent", timeoutMs: 60_000 });
    fake.update("child", { status: "completed" });
    fake.sendFailures.push(
      new DelegationControlError("DELEGATION_FAILED", "turn/start refused", { notStarted: true }),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(fake.sent).toEqual([]);
    await expect(service.watches()).resolves.toMatchObject({
      watches: [{ state: "pendingDelivery", outcome: "completed" }],
    });

    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(fake.sent).toHaveLength(1);
    await expect(service.watches()).resolves.toEqual({ watches: [] });
  });

  it("does not retry a structured failure that does not prove the Turn never started", async () => {
    const fake = runtime({ child: { status: "running" }, parent: { status: "completed" } });
    const service = new DelegationWatchService(fake, { pollIntervalMs: POLL_MS });
    await service.watch({ threadId: "child", notifyThreadId: "parent", timeoutMs: 60_000 });
    fake.update("child", { status: "completed" });
    // An adapter start whose acknowledgement timed out is wrapped like this.
    fake.sendFailures.push(
      new DelegationControlError(
        "DELEGATION_FAILED",
        "Aqua Harness broker session.execute timed out",
      ),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS * 5);
    expect(fake.send).toHaveBeenCalledOnce();
    const { watches } = await service.watches();
    expect(watches).toMatchObject([{ state: "undeliverable", outcome: "completed" }]);
    expect(watches[0]?.reason).toContain("Delivery outcome unknown");
  });

  it("does not retry a send whose outcome is unknown", async () => {
    const fake = runtime({ child: { status: "running" }, parent: { status: "completed" } });
    const service = new DelegationWatchService(fake, { pollIntervalMs: POLL_MS });
    await service.watch({ threadId: "child", notifyThreadId: "parent", timeoutMs: 60_000 });
    fake.update("child", { status: "completed" });
    fake.send.mockImplementationOnce(async () => {
      throw new Error("Official app-server request timed out");
    });
    await vi.advanceTimersByTimeAsync(POLL_MS * 5);
    expect(fake.send).toHaveBeenCalledOnce();
    const { watches } = await service.watches();
    expect(watches).toMatchObject([{ state: "undeliverable", outcome: "completed" }]);
    expect(watches[0]?.reason).toContain("Delivery outcome unknown");
    expect(watches[0]?.reason).toContain("timed out");
    expect(vi.getTimerCount()).toBe(0);
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

  it("notifies once per silence episode, rearms on activity, and still reports the final stop", async () => {
    const fake = runtime({ child: { status: "running" }, parent: { status: "completed" } });
    const service = new DelegationWatchService(fake, { pollIntervalMs: POLL_MS });
    await service.watch({
      threadId: "child",
      notifyThreadId: "parent",
      timeoutMs: 60_000,
      stallAfterMs: 3_000,
    });
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(fake.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.message).toContain(
      "codex://threads/child: stalled (Turn turn-child). It was still running, but no Harness event had been observed for at least 3 s.",
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.sent).toHaveLength(1);
    service.noteActivity(["unrelated"]);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(fake.sent).toHaveLength(1);
    service.noteActivity(["child"]);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(fake.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.sent).toHaveLength(2);
    fake.update("child", { status: "completed" });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(fake.sent).toHaveLength(3);
    expect(fake.sent[2]?.message).toContain("completed (Turn turn-child)");
    expect((await service.watches()).watches).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [90_000, "90 s"],
    [600_000, "10 min"],
    [1_500, "1500 ms"],
  ])(
    "states a %i ms silence threshold exactly and leaves progress to thread read",
    async (stallAfterMs, text) => {
      const fake = runtime({ child: { status: "running" }, parent: { status: "completed" } });
      const service = new DelegationWatchService(
        {
          read: async (input) => ({
            ...(await fake.read(input)),
            progress: [
              { id: "progress-1", turnId: "turn-child", text: "Compiling the release build" },
            ],
          }),
          send: fake.send,
        },
        { pollIntervalMs: 60_000 },
      );
      await service.watch({
        threadId: "child",
        notifyThreadId: "parent",
        timeoutMs: 60 * 60_000,
        stallAfterMs,
      });
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(fake.sent).toHaveLength(1);
      const message = fake.sent[0]?.message;
      expect(message).toContain(`no Harness event had been observed for at least ${text}.`);
      expect(message).toContain("read the Thread for its latest progress");
      expect(message).not.toContain("Compiling the release build");
      service.close();
    },
  );

  it("counts Harness subagent events as parent activity without the parent sending progress", async () => {
    const fake = runtime({ parent: { status: "running" }, subscriber: { status: "completed" } });
    const service = new DelegationWatchService(fake, { pollIntervalMs: POLL_MS });
    const activity = new ThreadActivity();
    activity.subscribe((threadIds) => service.noteActivity(threadIds));
    await service.watch({
      threadId: "parent",
      notifyThreadId: "subscriber",
      timeoutMs: 60_000,
      stallAfterMs: 3_000,
    });
    activity.note("subagent", "parent");
    for (let index = 0; index < 5; index += 1) {
      await vi.advanceTimersByTimeAsync(2_000);
      activity.observeOfficial({
        method: "item/commandExecution/outputDelta",
        params: { threadId: "subagent", delta: "tool output" },
      });
    }
    expect(fake.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fake.sent).toHaveLength(1);
    service.close();
  });

  it("keeps counting a grandchild's activity after the intermediate native Thread closes", async () => {
    const fake = runtime({ A: { status: "running" }, subscriber: { status: "completed" } });
    const service = new DelegationWatchService(fake, { pollIntervalMs: POLL_MS });
    const activity = new ThreadActivity();
    activity.subscribe((threadIds) => service.noteActivity(threadIds));
    await service.watch({
      threadId: "A",
      notifyThreadId: "subscriber",
      timeoutMs: 60_000,
      stallAfterMs: 3_000,
    });
    for (const [id, parent] of [
      ["B", "A"],
      ["C", "B"],
    ] as const) {
      activity.observeOfficial({
        method: "thread/started",
        params: {
          thread: { id, source: { subAgent: { thread_spawn: { parent_thread_id: parent } } } },
        },
      });
    }
    activity.observeOfficial({ method: "thread/closed", params: { threadId: "B" } });
    for (let index = 0; index < 5; index += 1) {
      await vi.advanceTimersByTimeAsync(2_000);
      activity.observeOfficial({
        method: "item/commandExecution/outputDelta",
        params: { threadId: "C", delta: "tool output" },
      });
    }
    expect(fake.sent).toHaveLength(0);
    activity.observeOfficial({ method: "thread/closed", params: { threadId: "C" } });
    expect(activity.size).toBe(0);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fake.sent[0]?.message).toContain(": stalled");
    service.close();
  });

  it("keeps silence detection disabled when the threshold is omitted", async () => {
    const fake = runtime({ child: { status: "running" }, parent: { status: "completed" } });
    const service = new DelegationWatchService(fake, { pollIntervalMs: POLL_MS });
    const result = await service.watch({
      threadId: "child",
      notifyThreadId: "parent",
      timeoutMs: 60_000,
    });
    expect(result).not.toHaveProperty("stallAfterMs");
    await vi.advanceTimersByTimeAsync(59_000);
    expect(fake.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(fake.sent[0]?.message).toContain("watch expired");
    expect(fake.sent[0]?.message).not.toContain(": stalled");
  });

  it("merges pending silence alerts and terminal notifications for the same subscriber", async () => {
    const fake = runtime({
      a: { status: "running" },
      b: { status: "running" },
      parent: { status: "running" },
    });
    const service = new DelegationWatchService(fake, { pollIntervalMs: POLL_MS });
    await service.watch({
      threadId: "a",
      notifyThreadId: "parent",
      timeoutMs: 60_000,
      stallAfterMs: 2_000,
    });
    await service.watch({ threadId: "b", notifyThreadId: "parent", timeoutMs: 60_000 });
    fake.sendFailures.push(busy());
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await service.watches()).watches).toMatchObject([
      { threadId: "a", state: "watching" },
      { threadId: "b", state: "watching" },
      { threadId: "a", state: "pendingDelivery", outcome: "stalled" },
    ]);
    fake.update("b", { status: "completed" });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.message).toContain("codex://threads/a: stalled");
    expect(fake.sent[0]?.message).toContain("codex://threads/b: completed");
    expect((await service.watches()).watches).toMatchObject([{ threadId: "a", state: "watching" }]);
    service.close();
  });

  it("preserves the original silence threshold on duplicate registration", async () => {
    const fake = runtime({ child: { status: "running" }, parent: { status: "completed" } });
    const service = new DelegationWatchService(fake, { pollIntervalMs: POLL_MS });
    await service.watch({
      threadId: "child",
      notifyThreadId: "parent",
      timeoutMs: 60_000,
      stallAfterMs: 3_000,
    });
    await expect(
      service.watch({
        threadId: "child",
        notifyThreadId: "parent",
        timeoutMs: 5_000,
        stallAfterMs: 1_000,
      }),
    ).resolves.toMatchObject({ timeoutMs: 60_000, stallAfterMs: 3_000 });
    service.close();
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects invalid stallAfterMs %s", async (stallAfterMs) => {
    const service = new DelegationWatchService(
      runtime({ child: { status: "running" }, parent: { status: "completed" } }),
    );
    await expect(
      service.watch({
        threadId: "child",
        notifyThreadId: "parent",
        timeoutMs: 60_000,
        stallAfterMs,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});
