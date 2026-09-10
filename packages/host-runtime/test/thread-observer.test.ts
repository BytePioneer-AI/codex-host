import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { observeThreads, parseObserveTargets } from "../src/thread-observer.js";
import { DelegationControlError, type ThreadWaitManyInput } from "../src/delegation-types.js";

function row(
  threadId = "child",
  seq = 1,
  state = "running",
  pendingInteractions: number | undefined = 0,
) {
  return {
    threadId,
    outcome: "changed",
    revision: `cursor-${seq}`,
    status: {
      threadId,
      harnessId: "grok",
      status: state,
      turn: { turnId: "turn-1", status: state },
      revision: `cursor-${seq}`,
      ...(pendingInteractions !== undefined ? { pendingInteractions } : {}),
    },
  };
}
function snapshot(...results: ReturnType<typeof row>[]) {
  return { timedOut: false, results };
}

afterEach(() => vi.useRealTimers());

describe("Thread observer", () => {
  it("renews 60s requests, suppresses progress, and returns once on completion", async () => {
    vi.useFakeTimers();
    const calls: ThreadWaitManyInput[] = [];
    const waitMany = vi.fn(async (input: ThreadWaitManyInput) => {
      calls.push(structuredClone(input));
      if (calls.length > 1) await new Promise((resolve) => setTimeout(resolve, input.timeoutMs));
      return snapshot(row("child", calls.length, calls.length === 4 ? "completed" : "running"));
    });
    const finished = vi.fn();
    const pending = observeThreads({
      targets: [{ threadId: "child" }],
      timeoutMs: 240_000,
      waitMany,
    }).then((v) => {
      finished();
      return v;
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(finished).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;
    expect(result).toMatchObject({
      reason: "attention",
      requests: 4,
      suppressedChanges: 2,
      events: [{ threadId: "child", reason: "terminal" }],
      elapsedMs: 180_000,
    });
    expect(calls.map((call) => call.timeoutMs)).toEqual([0, 60_000, 60_000, 60_000]);
    expect(calls[3]?.targets).toEqual([{ threadId: "child", afterRevision: "cursor-3" }]);
  });

  it("returns the earliest per-target review deadline without cancelling any child", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const waitMany = vi.fn(async (input: ThreadWaitManyInput) => {
      await new Promise((resolve) => setTimeout(resolve, input.timeoutMs));
      return snapshot(row("one"), row("two"));
    });
    const pending = observeThreads({
      timeoutMs: 300_000,
      targets: [
        { threadId: "one", reviewAt: new Date(start + 70_000).toISOString() },
        { threadId: "two", reviewAt: new Date(start + 150_000).toISOString() },
      ],
      waitMany,
    });
    await vi.advanceTimersByTimeAsync(70_000);
    expect(await pending).toMatchObject({
      reason: "review-due",
      events: [{ threadId: "one", reason: "review-due" }],
    });
    expect(waitMany.mock.calls.map(([input]) => input.timeoutMs)).toEqual([0, 60_000, 10_000]);
  });

  it.each(["failed", "interrupted", "completed"])(
    "returns an already %s target immediately",
    async (state) => {
      const result = await observeThreads({
        targets: [{ threadId: "child" }],
        timeoutMs: 1000,
        waitMany: async () => snapshot(row("child", 1, state)),
      });
      expect(result.events).toEqual([{ threadId: "child", reason: "terminal" }]);
      expect(result.requests).toBe(1);
    },
  );

  it("does not repeat an acknowledged terminal cursor", async () => {
    const result = await observeThreads({
      targets: [{ threadId: "child", afterRevision: "cursor-1" }],
      timeoutMs: 0,
      waitMany: async () => snapshot(row("child", 1, "completed")),
    });
    expect(result.reason).toBe("timeout");
    expect(result.events).toEqual([]);
  });

  it("detects pending input without parsing or returning message bodies", async () => {
    const value = row("child", 2, "running", 1);
    Object.assign(value.status, { text: "PRIVATE_TEXT", result: { text: "PRIVATE_RESULT" } });
    const result = await observeThreads({
      targets: [{ threadId: "child" }],
      timeoutMs: 1000,
      waitMany: async () => snapshot(value),
    });
    expect(result.events).toEqual([{ threadId: "child", reason: "needs-input" }]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  });

  it("does not claim pending-input visibility for an older Runtime", async () => {
    const value = row();
    delete (value.status as { pendingInteractions?: number }).pendingInteractions;
    const result = await observeThreads({
      targets: [{ threadId: "child" }],
      timeoutMs: 0,
      waitMany: async () => snapshot(value),
    });
    expect(result.inputVisibilityUnavailable).toEqual(["child"]);
  });

  it("stops at a replaced Turn instead of silently following new work", async () => {
    const result = await observeThreads({
      targets: [{ threadId: "child", expectedTurnId: "original" }],
      timeoutMs: 1000,
      waitMany: async () => snapshot(row()),
    });
    expect(result.events).toEqual([{ threadId: "child", reason: "turn-changed" }]);
  });

  it("returns resync and errors without spinning even when timedOut is true", async () => {
    const result = await observeThreads({
      targets: [{ threadId: "child" }, { threadId: "missing" }],
      timeoutMs: 1000,
      waitMany: async () => ({
        timedOut: true,
        results: [
          { ...row(), outcome: "resync" },
          {
            threadId: "missing",
            outcome: "error",
            error: { code: "THREAD_NOT_FOUND", message: "missing" },
          },
        ],
      }),
    });
    expect(result.events.map((event) => event.reason)).toEqual(["resync", "error"]);
    expect(result.requests).toBe(1);
  });

  it("aborts an in-flight transport and returns only observer cancellation", async () => {
    const controller = new AbortController();
    const waitMany = vi.fn(async (_input: ThreadWaitManyInput, signal: AbortSignal) => {
      await delay(60_000, undefined, { signal });
      return snapshot(row());
    });
    const pending = observeThreads({
      targets: [{ threadId: "child" }],
      timeoutMs: 90_000,
      signal: controller.signal,
      waitMany,
    });
    controller.abort();
    expect(await pending).toMatchObject({ reason: "cancelled", requests: 1 });
  });

  it("retries only bounded transport failures internally", async () => {
    vi.useFakeTimers();
    const waitMany = vi.fn(async () => {
      throw new DelegationControlError("RUNTIME_UNREACHABLE", "offline", { cause: "ECONNRESET" });
    });
    const pending = observeThreads({
      targets: [{ threadId: "child" }],
      timeoutMs: 90_000,
      waitMany,
    });
    const assertion = expect(pending).rejects.toMatchObject({ code: "RUNTIME_UNREACHABLE" });
    await vi.advanceTimersByTimeAsync(750);
    await assertion;
    expect(waitMany).toHaveBeenCalledTimes(3);
  });

  it("does not hide a zero-timeout protocol error as a successful timeout", async () => {
    await expect(
      observeThreads({
        targets: [{ threadId: "child" }],
        timeoutMs: 0,
        waitMany: async () => ({ timedOut: true, results: [] }),
      }),
    ).rejects.toThrow("Invalid wait-many response");
  });

  it("does not retry an authentication failure", async () => {
    const waitMany = vi.fn(async () => {
      throw new DelegationControlError("RUNTIME_UNREACHABLE", "invalid token");
    });
    await expect(
      observeThreads({ targets: [{ threadId: "child" }], timeoutMs: 90_000, waitMany }),
    ).rejects.toThrow("invalid token");
    expect(waitMany).toHaveBeenCalledTimes(1);
  });

  it.each([
    { timedOut: true, results: [] },
    { timedOut: false, results: [row("wrong")] },
    { timedOut: false, results: [row(), row()] },
    { timedOut: false, results: [{ ...row(), status: { ...row().status, threadId: "wrong" } }] },
    { timedOut: false, results: [row("child", 1, "mystery")] },
  ])("rejects incomplete or mismatched transport data", async (value) => {
    await expect(
      observeThreads({
        targets: [{ threadId: "child" }],
        timeoutMs: 1000,
        waitMany: async () => value,
      }),
    ).rejects.toThrow("Invalid wait-many response");
  });

  it.each([
    { value: [] },
    { value: [{ threadId: "a" }, { threadId: "codex://threads/a" }] },
    { value: [{ threadId: "a", reviewAt: "tomorrow" }] },
    { value: [{ threadId: "a", typo: 1 }] },
    { value: [{ threadId: "a", expectedTurnId: "" }] },
  ])("rejects ambiguous targets before observation", ({ value }) => {
    expect(() => parseObserveTargets(value)).toThrow("Invalid observe targets");
  });
});
