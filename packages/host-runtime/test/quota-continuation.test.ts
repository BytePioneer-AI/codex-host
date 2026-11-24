import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

import type { HarnessAdapter } from "@codexhost/harness-adapter";
import {
  DEFAULT_QUOTA_CONTINUATION_PROMPT,
  evaluateQuotaAvailability,
  harnessIdSchema,
  rankAlternativeHarnesses,
  type AccountCreditsSnapshot,
  type HarnessQuotaListResult,
  type HarnessQuotaSummary,
} from "@codexhost/shared-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runDelegationCli } from "../src/delegation-cli.js";
import { DelegationControlRegistry } from "../src/delegation-control-registry.js";
import {
  DelegationControlError,
  type DelegationControlApi,
  type DelegationControlRegistration,
  type DelegationPendingQuestion,
  type DelegationThreadSnapshot,
  type DelegationThreadStatus,
  type HarnessQuotaInput,
  type ThreadSendInput,
} from "../src/delegation-types.js";
import { externalClientMcp } from "../src/external-client-mcp.js";
import { externalClientRouter } from "../src/external-client-routes.js";
import {
  startExternalClientServer,
  type ExternalClientServer,
} from "../src/external-client-server.js";
import { ExternalClientRegistry } from "../src/external-clients.js";
import { collectHarnessQuotas } from "../src/harness-quota.js";
import { QuotaContinuationService } from "../src/quota-continuation.js";
import { FileQuotaContinuationStore } from "../src/quota-continuation-store.js";

interface FakeThreadState {
  harnessId: "codex" | "claude-code" | "antigravity" | "pi" | "deepseek-harness";
  status: DelegationThreadStatus;
  turnId?: string;
  title?: string;
  pendingQuestions?: DelegationPendingQuestion[];
}

function summary(
  harnessId: FakeThreadState["harnessId"],
  credits: AccountCreditsSnapshot | null,
  balance?: { amount: number; currency: string },
): HarnessQuotaSummary {
  const evaluated = evaluateQuotaAvailability({
    credits,
    ...(balance ? { balance } : {}),
    harnessId,
  });
  return {
    harnessId,
    harnessName: harnessId,
    poolKey: `${harnessId}:*`,
    status: evaluated.status,
    windows: evaluated.windows,
    blockingWindows: evaluated.blockingWindows,
    blockingPeriods: evaluated.blockingPeriods,
    ...(evaluated.minRemainingPercent !== undefined
      ? { minRemainingPercent: evaluated.minRemainingPercent }
      : {}),
    ...(evaluated.earliestUnblockAt ? { earliestUnblockAt: evaluated.earliestUnblockAt } : {}),
    allBlockingResetsKnown: evaluated.allBlockingResetsKnown,
    ...(balance ? { balance } : {}),
    ...(credits ? { accounts: [{ credits }] } : {}),
  };
}

function createFakeRuntime(
  threads: Record<string, FakeThreadState>,
  quotas: Record<
    string,
    { credits: AccountCreditsSnapshot | null; balance?: { amount: number; currency: string } }
  >,
) {
  const sent: ThreadSendInput[] = [];
  const sendFailures: DelegationControlError[] = [];
  const quotaCalls: HarnessQuotaInput[] = [];
  let turnCounter = 100;

  const read = vi.fn(async ({ threadId }: { threadId: string }) => {
    const thread = threads[threadId];
    if (!thread) throw new DelegationControlError("THREAD_NOT_FOUND", "Thread was not found");
    return {
      threadId,
      harnessId: thread.harnessId,
      status: thread.status,
      ...(thread.title ? { title: thread.title } : {}),
      turn: thread.turnId ? { turnId: thread.turnId, status: thread.status } : null,
      progress: [],
      result: { availability: "unavailable" },
      ...(thread.pendingQuestions ? { pendingQuestions: thread.pendingQuestions } : {}),
    } as DelegationThreadSnapshot;
  });

  const send = vi.fn(async (input: ThreadSendInput) => {
    const failure = sendFailures.shift();
    if (failure) throw failure;
    const thread = threads[input.threadId];
    if (!thread) throw new DelegationControlError("THREAD_NOT_FOUND", "Thread was not found");
    const turnId = `turn-${++turnCounter}`;
    thread.status = "running";
    thread.turnId = turnId;
    sent.push(input);
    return {
      threadId: input.threadId,
      turnId,
      harnessId: thread.harnessId,
      status: "running" as const,
      next: { read: "read", wait: "wait" },
    };
  });

  const quota = vi.fn(async (input: HarnessQuotaInput = {}): Promise<HarnessQuotaListResult> => {
    quotaCalls.push(input);
    const ids = input.harnessId
      ? ([input.harnessId] as FakeThreadState["harnessId"][])
      : (Object.keys(quotas) as FakeThreadState["harnessId"][]);
    const harnesses = ids.flatMap((id) => {
      const entry = quotas[id];
      return entry ? [summary(id, entry.credits, entry.balance)] : [];
    });
    return {
      observedAt: new Date(Date.now()).toISOString(),
      harnesses,
      availableAlternatives: rankAlternativeHarnesses(harnesses),
    };
  });

  const updateThread = (threadId: string, patch: Partial<FakeThreadState>) => {
    const existing = threads[threadId];
    if (!existing) throw new Error(`Unknown thread ${threadId}`);
    Object.assign(existing, patch);
  };

  return { threads, quotas, sent, sendFailures, quotaCalls, read, send, quota, updateThread };
}

describe("QuotaContinuationService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-24T10:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits until MAX(resetsAt) across 5h and 7d windows, confirms live rollover with backoff, then resumes once", async () => {
    const fiveHourReset = "2026-11-24T10:05:00.000Z";
    const sevenDayReset = "2026-11-24T10:15:00.000Z";
    const fake = createFakeRuntime(
      { "t-claude": { harnessId: "claude-code", status: "failed", turnId: "turn-1" } },
      {
        "claude-code": {
          credits: {
            periodType: "five_hour",
            usedPercent: 100,
            resetsAt: fiveHourReset,
            productUsage: [
              {
                product: "7-day window",
                periodType: "seven_day",
                usagePercent: 100,
                resetsAt: sevenDayReset,
              },
            ],
          },
        },
        antigravity: {
          credits: {
            periodType: "five_hour",
            usedPercent: 20,
            resetsAt: "2026-11-24T14:00:00.000Z",
          },
        },
      },
    );

    const service = new QuotaContinuationService(fake, {
      verifyBackoffBaseMs: 10_000,
      refreshCooldownMs: 5_000,
    });

    const scheduled = await service.continueOnReset({
      threadId: "t-claude",
      resetGraceMs: 10_000,
    });
    expect(scheduled).toMatchObject({
      threadId: "t-claude",
      harnessId: "claude-code",
      state: "waitingForReset",
      targetResetAt: sevenDayReset,
      blockingPeriods: ["five_hour", "seven_day"],
      availableAlternatives: [{ harnessId: "antigravity", minRemainingPercent: 80 }],
    });

    // Passing the 5-hour reset must NOT wake the Thread while 7-day is still blocking.
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(fake.sent).toHaveLength(0);

    // Reaching 7d reset + grace while upstream still hasn't rolled over -> enters verifying backoff.
    await vi.advanceTimersByTimeAsync(9 * 60_000 + 10_000);
    expect(fake.sent).toHaveLength(0);
    expect((await service.continuations()).continuations[0]).toMatchObject({
      state: "verifying",
    });

    // Upstream rolls over; next backoff probe confirms availability and resumes the Thread once.
    fake.quotas["claude-code"] = {
      credits: {
        periodType: "five_hour",
        usedPercent: 0,
        resetsAt: "2026-11-24T15:15:00.000Z",
        productUsage: [
          {
            product: "7-day window",
            periodType: "seven_day",
            usagePercent: 0,
            resetsAt: "2026-12-01T10:15:00.000Z",
          },
        ],
      },
    };
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.sent).toEqual([
      { threadId: "t-claude", message: DEFAULT_QUOTA_CONTINUATION_PROMPT },
    ]);
    expect((await service.continuations()).continuations[0]).toMatchObject({
      state: "resumed",
      resumedTurnId: "turn-101",
    });
    service.close();
  });

  it("coalesces single-flight probes and serializes multi-Thread/multi-Harness wakeups per pool with headroom guard", async () => {
    const resetAt = "2026-11-24T10:02:00.000Z";
    const fake = createFakeRuntime(
      {
        "t-low": { harnessId: "codex", status: "failed", turnId: "t1" },
        "t-high": { harnessId: "codex", status: "failed", turnId: "t2" },
        "t-pi-shared": { harnessId: "pi", status: "failed", turnId: "t3" },
      },
      {
        codex: { credits: { periodType: "five_hour", usedPercent: 100, resetsAt: resetAt } },
        pi: { credits: { periodType: "five_hour", usedPercent: 100, resetsAt: resetAt } },
      },
    );

    const service = new QuotaContinuationService(fake, {
      refreshCooldownMs: 15_000,
      verifyBackoffBaseMs: 5_000,
    });

    await service.continueOnReset({
      threadId: "t-low",
      poolKey: "openai-main",
      priority: 1,
      minHeadroomPercent: 20,
      maxConcurrentPerPool: 1,
      resetGraceMs: 0,
      prompt: "resume low",
    });
    await service.continueOnReset({
      threadId: "t-high",
      poolKey: "openai-main",
      priority: 10,
      minHeadroomPercent: 20,
      maxConcurrentPerPool: 1,
      resetGraceMs: 0,
      prompt: "resume high",
    });
    await service.continueOnReset({
      threadId: "t-pi-shared",
      poolKey: "openai-main",
      priority: 5,
      minHeadroomPercent: 20,
      maxConcurrentPerPool: 1,
      resetGraceMs: 0,
      prompt: "resume pi",
    });

    fake.quotaCalls.length = 0;
    // Pool refreshes to 0% used.
    fake.quotas.codex = {
      credits: { periodType: "five_hour", usedPercent: 0, resetsAt: "2026-11-24T15:02:00.000Z" },
    };
    fake.quotas.pi = {
      credits: { periodType: "five_hour", usedPercent: 0, resetsAt: "2026-11-24T15:02:00.000Z" },
    };

    await vi.advanceTimersByTimeAsync(2 * 60_000);

    // Single-flight coalescing: only 1 probe for codex (not 2) and 1 for pi.
    expect(fake.quotaCalls.filter((call) => call.harnessId === "codex")).toHaveLength(1);
    // Strict concurrency=1 and priority order: only highest-priority Thread resumed first.
    expect(fake.sent).toEqual([{ threadId: "t-high", message: "resume high" }]);

    // t-high completes and leaves plenty of headroom (30% used => 70% remaining >= 20%).
    fake.updateThread("t-high", { status: "completed" });
    fake.quotas.pi = {
      credits: { periodType: "five_hour", usedPercent: 30, resetsAt: "2026-11-24T15:02:00.000Z" },
    };
    service.nudge("t-high");
    await vi.advanceTimersByTimeAsync(0);

    // Next in priority within the shared pool across Harnesses is t-pi-shared (priority 5).
    expect(fake.sent).toEqual([
      { threadId: "t-high", message: "resume high" },
      { threadId: "t-pi-shared", message: "resume pi" },
    ]);

    // t-pi-shared finishes, but now pool headroom dropped to 10% remaining (< minHeadroomPercent 20%).
    fake.updateThread("t-pi-shared", { status: "completed" });
    fake.quotas.codex = {
      credits: { periodType: "five_hour", usedPercent: 90, resetsAt: "2026-11-24T15:02:00.000Z" },
    };
    service.nudge("t-pi-shared");
    await vi.advanceTimersByTimeAsync(0);

    // Headroom guard holds t-low back into waitingForReset for the next window instead of firing.
    expect(fake.sent).toHaveLength(2);
    const lowEntry = (await service.continuations()).continuations.find(
      (entry) => entry.threadId === "t-low",
    );
    expect(lowEntry).toMatchObject({
      state: "waitingForReset",
      targetResetAt: "2026-11-24T15:02:00.000Z",
    });
    service.close();
  });

  it("rejects prepaidOnly, reports alreadyAvailable and exceedsMaxWait with alternatives", async () => {
    const fake = createFakeRuntime(
      {
        "t-dsh": { harnessId: "deepseek-harness", status: "failed", turnId: "t1" },
        "t-codex": { harnessId: "codex", status: "failed", turnId: "t2" },
        "t-claude": { harnessId: "claude-code", status: "failed", turnId: "t3" },
      },
      {
        "deepseek-harness": { credits: null, balance: { amount: 25, currency: "CNY" } },
        codex: {
          credits: {
            periodType: "five_hour",
            usedPercent: 25,
            resetsAt: "2026-11-24T15:00:00.000Z",
          },
        },
        "claude-code": {
          credits: {
            periodType: "seven_day",
            usedPercent: 100,
            resetsAt: "2026-11-29T10:00:00.000Z",
          },
        },
      },
    );

    const service = new QuotaContinuationService(fake);

    await expect(service.continueOnReset({ threadId: "t-dsh" })).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });

    await expect(service.continueOnReset({ threadId: "t-codex" })).resolves.toMatchObject({
      state: "alreadyAvailable",
    });

    // Weekly reset is 5 days away, exceeding a 6-hour maxWaitMs => returns ranked alternatives.
    await expect(
      service.continueOnReset({ threadId: "t-claude", maxWaitMs: 6 * 60 * 60_000 }),
    ).resolves.toMatchObject({
      state: "exceedsMaxWait",
      targetResetAt: "2026-11-29T10:00:00.000Z",
      blockingPeriods: ["seven_day"],
      availableAlternatives: [{ harnessId: "codex", minRemainingPercent: 75 }],
    });
    expect((await service.continuations()).continuations).toEqual([]);
    service.close();
  });

  it("auto-cancels when user activity occurs while waiting and never double-sends on unknown error", async () => {
    const resetAt = "2026-11-24T10:01:00.000Z";
    const fake = createFakeRuntime(
      {
        "t-user": { harnessId: "codex", status: "failed", turnId: "turn-1" },
        "t-unknown": { harnessId: "claude-code", status: "failed", turnId: "turn-2" },
      },
      {
        codex: { credits: { periodType: "five_hour", usedPercent: 100, resetsAt: resetAt } },
        "claude-code": {
          credits: { periodType: "five_hour", usedPercent: 100, resetsAt: resetAt },
        },
      },
    );

    const service = new QuotaContinuationService(fake);
    await service.continueOnReset({ threadId: "t-user", resetGraceMs: 0 });
    await service.continueOnReset({ threadId: "t-unknown", resetGraceMs: 0 });

    // User manually sent a new Turn on t-user while waiting.
    fake.updateThread("t-user", { turnId: "turn-manual", status: "completed" });

    // Quota refreshes for both; t-unknown's send throws an unknown-outcome error.
    fake.quotas.codex = {
      credits: { periodType: "five_hour", usedPercent: 0, resetsAt: "2026-11-24T15:01:00.000Z" },
    };
    fake.quotas["claude-code"] = {
      credits: { periodType: "five_hour", usedPercent: 0, resetsAt: "2026-11-24T15:01:00.000Z" },
    };
    fake.sendFailures.push(new DelegationControlError("DELEGATION_FAILED", "Timed out confirming"));

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.sent).toEqual([]);

    const entries = (await service.continuations()).continuations;
    expect(entries.find((e) => e.threadId === "t-user")).toMatchObject({ state: "cancelled" });
    expect(entries.find((e) => e.threadId === "t-unknown")).toMatchObject({
      state: "failed",
      reason: expect.stringContaining("outcome unknown"),
    });

    // Advancing further must NOT retry the unknown-outcome dispatch.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fake.send).toHaveBeenCalledTimes(1);
    service.close();
  });

  it("persists continuations across restart adoption and conservatively fails in-flight dispatches", async () => {
    vi.useRealTimers();
    const dir = await mkdtemp(path.join(os.tmpdir(), "quota-cont-store-"));
    try {
      let currentNow = Date.parse("2026-11-24T10:00:00.000Z");
      const resetAt = "2026-11-24T10:02:00.000Z";
      const fake = createFakeRuntime(
        {
          "t-wait": { harnessId: "codex", status: "failed", turnId: "t1" },
          "t-crash": { harnessId: "claude-code", status: "failed", turnId: "t2" },
        },
        {
          codex: { credits: { periodType: "five_hour", usedPercent: 100, resetsAt: resetAt } },
          "claude-code": {
            credits: { periodType: "five_hour", usedPercent: 100, resetsAt: resetAt },
          },
        },
      );
      const store1 = new FileQuotaContinuationStore(dir);
      const service1 = new QuotaContinuationService(fake, {
        store: store1,
        now: () => currentNow,
        maxTimerSliceMs: 25,
      });
      const first = await service1.continueOnReset({ threadId: "t-wait", resetGraceMs: 0 });
      const second = await service1.continueOnReset({ threadId: "t-crash", resetGraceMs: 0 });
      service1.close();

      const firstId = first.id;
      const secondId = second.id;
      expect(firstId).toBeTruthy();
      expect(secondId).toBeTruthy();

      // Simulate dead previous owner PID and mark second record as mid-dispatch before crash.
      for (const id of [firstId, secondId]) {
        if (!id) continue;
        const file = path.join(dir, `${id}.json`);
        const parsed = JSON.parse(await readFile(file, "utf8")) as {
          formatVersion: 1;
          owner: { pid: number; boot: number };
          continuation: Record<string, unknown>;
        };
        parsed.owner = { pid: 999_999, boot: 1 };
        if (id === secondId) parsed.continuation.dispatching = true;
        await writeFile(file, `${JSON.stringify(parsed)}\n`, "utf8");
      }

      // Advance logical clock past the reset while Runtime was stopped; new Runtime adopts both.
      currentNow = Date.parse("2026-11-24T10:03:00.000Z");
      fake.quotas.codex = {
        credits: { periodType: "five_hour", usedPercent: 0, resetsAt: "2026-11-24T15:02:00.000Z" },
      };
      const store2 = new FileQuotaContinuationStore(dir);
      const service2 = new QuotaContinuationService(fake, {
        store: store2,
        now: () => currentNow,
        maxTimerSliceMs: 25,
      });
      const restored = (await service2.continuations()).continuations;
      expect(restored.find((e) => e.threadId === "t-crash")).toMatchObject({
        state: "failed",
        reason: expect.stringContaining("restarted while continuation dispatch"),
      });

      await vi.waitFor(
        () => {
          expect(fake.sent).toEqual([
            { threadId: "t-wait", message: DEFAULT_QUOTA_CONTINUATION_PROMPT },
          ]);
        },
        { timeout: 2_000 },
      );
      service2.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Multi-Harness Watch + Registry coordination", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-24T10:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("defers watch delivery while parent Thread is waiting for quota reset, then delivers after unblock", async () => {
    const resetAt = "2026-11-24T10:02:00.000Z";
    const fake = createFakeRuntime(
      {
        parent: { harnessId: "codex", status: "failed", turnId: "p-1" },
        child: { harnessId: "claude-code", status: "running", turnId: "c-1", title: "Subtask" },
      },
      {
        codex: { credits: { periodType: "five_hour", usedPercent: 100, resetsAt: resetAt } },
        "claude-code": {
          credits: {
            periodType: "five_hour",
            usedPercent: 10,
            resetsAt: "2026-11-24T14:00:00.000Z",
          },
        },
      },
    );

    const idleListeners = new Set<(threadId: string) => void>();
    const registration: DelegationControlRegistration = {
      listHarnesses: vi.fn(async () => ({
        harnesses: ["codex", harnessIdSchema.parse("claude-code")],
      })),
      inspect: vi.fn(),
      quota: fake.quota,
      start: vi.fn(),
      send: fake.send,
      cancel: vi.fn(async ({ threadId }) => ({
        threadId,
        turnId: null,
        harnessId: "codex" as const,
        cancelled: true,
      })),
      read: fake.read,
      wait: vi.fn(),
      answer: vi.fn(),
      list: vi.fn(),
      canHandleStart: () => true,
      ownsThread: () => true,
      onThreadIdle: (listener) => {
        idleListeners.add(listener);
        return () => idleListeners.delete(listener);
      },
    };

    const registry = new DelegationControlRegistry();
    registry.register(registration, { harnessCatalog: true });

    // Parent watches child AND schedules continuation for its own 5h reset.
    await registry.watch({ threadId: "child", notifyThreadId: "parent", timeoutMs: 600_000 });
    await registry.continueOnReset({
      threadId: "parent",
      resetGraceMs: 0,
      prompt: "continue parent",
    });

    // Child finishes while Parent is still quota-exhausted.
    fake.updateThread("child", { status: "completed" });
    await vi.advanceTimersByTimeAsync(10_000);

    // Watch MUST stay pendingDelivery and NOT fire a doomed Turn on exhausted parent.
    expect(fake.sent).toEqual([]);
    expect((await registry.watches()).watches).toMatchObject([
      {
        threadId: "child",
        notifyThreadId: "parent",
        state: "pendingDelivery",
        outcome: "completed",
      },
    ]);

    // Parent quota resets -> continuation resumes Parent first.
    fake.quotas.codex = {
      credits: { periodType: "five_hour", usedPercent: 0, resetsAt: "2026-11-24T15:02:00.000Z" },
    };
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(fake.sent[0]).toEqual({ threadId: "parent", message: "continue parent" });

    // Once Parent finishes its resumed Turn (becomes idle), deferred watch notification is delivered.
    fake.updateThread("parent", { status: "completed" });
    for (const listener of idleListeners) listener("parent");
    await vi.advanceTimersByTimeAsync(2_000);

    expect(fake.sent).toHaveLength(2);
    expect(fake.sent[1]?.threadId).toBe("parent");
    expect(fake.sent[1]?.message).toContain("thread://child");
    expect((await registry.watches()).watches).toEqual([]);
    registry.close();
  });

  it("cancels scheduled continuations on manual send or thread cancel through Registry", async () => {
    const fake = createFakeRuntime(
      { "t-1": { harnessId: "codex", status: "failed", turnId: "turn-1" } },
      {
        codex: {
          credits: {
            periodType: "five_hour",
            usedPercent: 100,
            resetsAt: "2026-11-24T12:00:00.000Z",
          },
        },
      },
    );
    const registration: DelegationControlRegistration = {
      listHarnesses: vi.fn(),
      inspect: vi.fn(),
      quota: fake.quota,
      start: vi.fn(),
      send: fake.send,
      cancel: vi.fn(async ({ threadId }) => ({
        threadId,
        turnId: null,
        harnessId: "codex" as const,
        cancelled: false,
      })),
      read: fake.read,
      wait: vi.fn(),
      answer: vi.fn(),
      list: vi.fn(),
      canHandleStart: () => true,
      ownsThread: () => true,
    };

    const registry = new DelegationControlRegistry();
    registry.register(registration, { harnessCatalog: true });

    await registry.continueOnReset({ threadId: "t-1" });
    await registry.send({ threadId: "t-1", message: "manual nudge" });
    expect((await registry.continuations()).continuations[0]).toMatchObject({
      state: "cancelled",
      reason: "Cancelled because a new message was sent",
    });

    fake.updateThread("t-1", { status: "failed" });
    await registry.continueOnReset({ threadId: "t-1" });
    await registry.cancel({ threadId: "t-1" });
    expect((await registry.continuations()).continuations.at(-1)).toMatchObject({
      state: "cancelled",
      reason: "Cancelled by thread cancel",
    });
    registry.close();
  });
});

describe("collectHarnessQuotas & CLI / HTTP / MCP parity", () => {
  let directory: string;
  let server: ExternalClientServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("collects read-only Codex + external Harness quotas and skips unrelated probes when filtered", async () => {
    const claudeId = harnessIdSchema.parse("claude-code");
    const agyId = harnessIdSchema.parse("antigravity");
    const inspectClaude = vi.fn(async () => ({
      harnessId: claudeId,
      harnessName: "Claude Code",
      account: {
        plan: "max",
        credits: {
          periodType: "five_hour" as const,
          usedPercent: 100,
          resetsAt: "2026-11-24T12:00:00.000Z",
        },
      },
    }));
    const inspectAgy = vi.fn(async () => ({
      harnessId: agyId,
      harnessName: "Antigravity",
      account: {
        credits: {
          periodType: "five_hour" as const,
          usedPercent: 20,
          resetsAt: "2026-11-24T13:00:00.000Z",
        },
      },
    }));
    const adapters = [
      { harnessId: claudeId, inspectAccount: vi.fn() } as unknown as HarnessAdapter,
      { harnessId: agyId, inspectAccount: vi.fn() } as unknown as HarnessAdapter,
    ];
    const readCodex = vi.fn(async () => ({
      plan: "pro",
      credits: {
        periodType: "five_hour" as const,
        usedPercent: 40,
        resetsAt: "2026-11-24T12:30:00.000Z",
      },
      hasResetCredits: true,
    }));

    const all = await collectHarnessQuotas({
      readCodex,
      adapters,
      descriptors: [],
      inspectHarnessAccount: (adapter) =>
        adapter.harnessId === "claude-code" ? inspectClaude() : inspectAgy(),
    });
    expect(all.harnesses.map((item) => [item.harnessId, item.status])).toEqual([
      ["codex", "available"],
      ["claude-code", "exhausted"],
      ["antigravity", "available"],
    ]);
    expect(all.harnesses[0]?.hasResetCredits).toBe(true);
    expect(all.availableAlternatives.map((alt) => alt.harnessId)).toEqual(["antigravity", "codex"]);

    // Filtered query must only probe the requested Harness.
    readCodex.mockClear();
    inspectClaude.mockClear();
    inspectAgy.mockClear();
    const onlyClaude = await collectHarnessQuotas({
      input: { harnessId: "claude-code", refresh: true },
      readCodex,
      adapters,
      descriptors: [],
      inspectHarnessAccount: (adapter) =>
        adapter.harnessId === "claude-code" ? inspectClaude() : inspectAgy(),
    });
    expect(onlyClaude.harnesses).toHaveLength(1);
    expect(readCodex).not.toHaveBeenCalled();
    expect(inspectAgy).not.toHaveBeenCalled();
    expect(inspectClaude).toHaveBeenCalledOnce();
  });

  it("enforces read vs dispatch scopes and HTTP/MCP/CLI parity for quota and continuation routes", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "quota-parity-"));
    const clients = new ExternalClientRegistry(path.join(directory, "clients.json"));
    const reader = await clients.add("reader", "read");
    const dispatcher = await clients.add("dispatcher", "dispatch");

    const quotaResult: HarnessQuotaListResult = {
      observedAt: "2026-11-24T10:00:00.000Z",
      harnesses: [
        summary("claude-code", {
          periodType: "five_hour",
          usedPercent: 100,
          resetsAt: "2026-11-24T12:00:00.000Z",
        }),
      ],
      availableAlternatives: [],
    };
    const continueOnReset = vi.fn(async () => ({
      id: "cont-1",
      threadId: "t-1",
      harnessId: "claude-code" as const,
      poolKey: "claude-code:*",
      state: "waitingForReset" as const,
      targetResetAt: "2026-11-24T12:00:00.000Z",
    }));
    const continuations = vi.fn(async () => ({ continuations: [] }));
    const cancelContinuation = vi.fn(async () => ({
      threadId: "t-1",
      cancelled: true,
      cancelledCount: 1,
    }));

    const api: DelegationControlApi = {
      listHarnesses: vi.fn(),
      inspect: vi.fn(),
      quota: vi.fn(async () => quotaResult),
      start: vi.fn(),
      send: vi.fn(),
      cancel: vi.fn(),
      read: vi.fn(),
      wait: vi.fn(),
      answer: vi.fn(),
      list: vi.fn(),
    };
    const route = externalClientRouter({
      api,
      continuationApi: { continueOnReset, continuations, cancelContinuation },
    });
    server = await startExternalClientServer({
      port: 0,
      clients,
      route,
      streams: { "/mcp": externalClientMcp(route) },
      descriptorPath: path.join(directory, "endpoint.json"),
    });
    if (!server) throw new Error("External client server failed to start");
    const endpoint = server.endpoint;

    // Read-only client can read quota & continuations, but is FORBIDDEN from scheduling/cancelling.
    const readQuota = await fetch(new URL("/v1/harness/quota", endpoint), {
      method: "POST",
      headers: { authorization: `Bearer ${reader.token}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(readQuota.status).toBe(200);
    expect(await readQuota.json()).toEqual(quotaResult);

    const readDenied = await fetch(new URL("/v1/thread/continue-on-reset", endpoint), {
      method: "POST",
      headers: { authorization: `Bearer ${reader.token}`, "content-type": "application/json" },
      body: JSON.stringify({ threadId: "t-1" }),
    });
    expect(readDenied.status).toBe(400);
    expect(await readDenied.json()).toMatchObject({ error: { code: "FORBIDDEN" } });

    // MCP dispatch client can schedule & cancel continuations cleanly.
    const mcpSchedule = await fetch(new URL("/mcp", endpoint), {
      method: "POST",
      headers: { authorization: `Bearer ${dispatcher.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "thread_continue_on_reset",
          arguments: { thread: "codex://threads/t-1", priority: 5, poolKey: "shared" },
        },
      }),
    });
    expect(mcpSchedule.status).toBe(200);
    expect((await mcpSchedule.json()).result.structuredContent).toMatchObject({
      id: "cont-1",
      state: "waitingForReset",
    });
    expect(continueOnReset).toHaveBeenCalledWith({
      threadId: "t-1",
      priority: 5,
      poolKey: "shared",
    });

    // CLI compact/text formatting works end-to-end against the same endpoint.
    const capture = async (args: string[]) => {
      let stdout = "";
      let stderr = "";
      const out = new Writable({
        write(chunk, _enc, cb) {
          stdout += String(chunk);
          cb();
        },
      });
      const err = new Writable({
        write(chunk, _enc, cb) {
          stderr += String(chunk);
          cb();
        },
      });
      const code = await runDelegationCli({
        arguments: args,
        environment: {
          CODEXHOST_RUNTIME_ENDPOINT: endpoint,
          CODEXHOST_RUNTIME_TOKEN: dispatcher.token,
        },
        output: out,
        diagnosticOutput: err,
      });
      return { code, stdout, stderr };
    };

    const cliQuota = await capture(["harness", "quota", "--format", "compact"]);
    expect(cliQuota.code).toBe(0);
    expect(JSON.parse(cliQuota.stdout)).toMatchObject({
      harnesses: [{ harnessId: "claude-code", status: "exhausted" }],
    });

    const cliCancel = await capture([
      "thread",
      "continue-cancel",
      "codex://threads/t-1",
      "--format",
      "text",
    ]);
    expect(cliCancel.code).toBe(0);
    expect(cliCancel.stdout).toContain("cancelled: true");
  });
});
