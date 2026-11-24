import { randomUUID } from "node:crypto";

import type { RoutedHarnessId } from "@codexhost/protocol-core";
import {
  DEFAULT_QUOTA_CONTINUATION_PROMPT,
  deriveQuotaPoolKey,
  evaluateQuotaAvailability,
  rankAlternativeHarnesses,
  type HarnessQuotaListResult,
  type HarnessQuotaSummary,
  type QuotaAvailabilityEvaluation,
  type QuotaContinuationState,
} from "@codexhost/shared-contracts";

import { MAX_CLI_TEXT_INPUT_BYTES } from "./delegation-cli-text-input.js";
import {
  DEFAULT_QUOTA_CONTINUATION_MAX_WAIT_MS,
  DEFAULT_QUOTA_RESET_GRACE_MS,
  DelegationControlError,
  type DelegationControlApi,
  type DelegationThreadSnapshot,
  type ThreadContinuationEntry,
  type ThreadContinuationListResult,
  type ThreadContinueCancelInput,
  type ThreadContinueCancelResult,
  type ThreadContinueOnResetInput,
  type ThreadContinueOnResetResult,
} from "./delegation-types.js";
import type {
  PersistedQuotaContinuation,
  QuotaContinuationStore,
} from "./quota-continuation-store.js";

const MAX_TIMER_SLICE_MS = 60_000;
const DEFAULT_REFRESH_COOLDOWN_MS = 15_000;
const DEFAULT_VERIFY_BACKOFF_BASE_MS = 30_000;
const DEFAULT_VERIFY_BACKOFF_MAX_MS = 300_000;
const DEFAULT_RESTORE_GRACE_MS = 5 * 60_000;
const MAX_RESET_GRACE_MS = 3_600_000;
const MAX_CONCURRENT_PER_POOL = 16;
const MAX_TERMINAL_ENTRIES = 50;

interface Entry extends PersistedQuotaContinuation {
  /** Restored continuation: read failures mean the owning session is not back yet. */
  restoreGraceUntil?: number;
}

interface RefreshCacheEntry {
  fetchedAt: number;
  result: HarnessQuotaListResult;
}

function isActiveState(state: QuotaContinuationState): boolean {
  return state === "waitingForReset" || state === "verifying" || state === "readyToResume";
}

function isDeferredForQuotaState(state: QuotaContinuationState): boolean {
  return isActiveState(state);
}

function persisted(entry: Entry): PersistedQuotaContinuation {
  const {
    id,
    threadId,
    harnessId,
    poolKey,
    scopeId,
    state,
    priority,
    registeredAt,
    targetResetAt,
    deadlineAt,
    nextCheckAt,
    minHeadroomPercent,
    maxConcurrentPerPool,
    blockingPeriods,
    availableAlternatives,
    resumedAt,
    resumedTurnId,
    reason,
    taskName,
    prompt,
    baselineTurnId,
    targetResetAtMs,
    deadlineMs,
    nextCheckAtMs,
    resetGraceMs,
    verifyAttempt,
    explicitWaitUntil,
    dispatching,
  } = entry;
  return {
    id,
    threadId,
    harnessId,
    poolKey,
    state,
    priority,
    registeredAt,
    deadlineAt,
    minHeadroomPercent,
    maxConcurrentPerPool,
    prompt,
    deadlineMs,
    resetGraceMs,
    ...(scopeId ? { scopeId } : {}),
    ...(targetResetAt ? { targetResetAt } : {}),
    ...(nextCheckAt ? { nextCheckAt } : {}),
    ...(blockingPeriods?.length ? { blockingPeriods } : {}),
    ...(availableAlternatives?.length ? { availableAlternatives } : {}),
    ...(resumedAt ? { resumedAt } : {}),
    ...(resumedTurnId ? { resumedTurnId } : {}),
    ...(reason ? { reason } : {}),
    ...(taskName ? { taskName } : {}),
    ...(baselineTurnId ? { baselineTurnId } : {}),
    ...(targetResetAtMs !== undefined ? { targetResetAtMs } : {}),
    ...(nextCheckAtMs !== undefined ? { nextCheckAtMs } : {}),
    ...(verifyAttempt !== undefined ? { verifyAttempt } : {}),
    ...(explicitWaitUntil ? { explicitWaitUntil } : {}),
    ...(dispatching ? { dispatching } : {}),
  };
}

function publicEntry(entry: Entry, snapshot?: DelegationThreadSnapshot): ThreadContinuationEntry {
  const taskName = snapshot?.title || entry.taskName;
  return {
    id: entry.id,
    threadId: entry.threadId,
    harnessId: entry.harnessId,
    poolKey: entry.poolKey,
    ...(entry.scopeId ? { scopeId: entry.scopeId } : {}),
    state: entry.state,
    priority: entry.priority,
    registeredAt: entry.registeredAt,
    ...(entry.targetResetAt ? { targetResetAt: entry.targetResetAt } : {}),
    deadlineAt: entry.deadlineAt,
    ...(entry.nextCheckAt ? { nextCheckAt: entry.nextCheckAt } : {}),
    minHeadroomPercent: entry.minHeadroomPercent,
    maxConcurrentPerPool: entry.maxConcurrentPerPool,
    ...(entry.blockingPeriods?.length ? { blockingPeriods: entry.blockingPeriods } : {}),
    ...(entry.availableAlternatives?.length
      ? { availableAlternatives: entry.availableAlternatives }
      : {}),
    ...(entry.resumedAt ? { resumedAt: entry.resumedAt } : {}),
    ...(entry.resumedTurnId ? { resumedTurnId: entry.resumedTurnId } : {}),
    ...(entry.reason ? { reason: entry.reason } : {}),
    ...(taskName ? { taskName } : {}),
    ...(snapshot ? { threadStatus: snapshot.status } : {}),
  };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof DelegationControlError ? error.code : undefined;
}

function dispatchFailure(error: unknown): "permanent" | "rejected" | "unknown" {
  if (!(error instanceof DelegationControlError)) return "unknown";
  if (error.code === "THREAD_NOT_FOUND" || error.details?.readOnly === true) return "permanent";
  if (error.code === "THREAD_BUSY" || error.details?.notStarted === true) return "rejected";
  return "unknown";
}

function evaluateSummary(
  summary: HarnessQuotaSummary | undefined,
  options: { harnessId: string; scopeId?: string; minHeadroomPercent: number },
): QuotaAvailabilityEvaluation {
  if (!summary) {
    return {
      status: "unknown",
      windows: [],
      blockingWindows: [],
      blockingPeriods: [],
      allBlockingResetsKnown: false,
    };
  }
  const primaryAccount = summary.accounts?.find((account) => account.credits);
  if (primaryAccount?.credits) {
    return evaluateQuotaAvailability({
      credits: primaryAccount.credits,
      ...(summary.balance ? { balance: summary.balance } : {}),
      harnessId: options.harnessId,
      ...(options.scopeId ? { scopeId: options.scopeId } : {}),
      minHeadroomPercent: options.minHeadroomPercent,
    });
  }
  if (summary.status === "prepaidOnly") {
    return {
      status: "prepaidOnly",
      windows: [],
      blockingWindows: [],
      blockingPeriods: [],
      allBlockingResetsKnown: false,
    };
  }
  if (summary.windows.length > 0) {
    const primary = summary.windows.find((window) => window.isPrimary) ?? summary.windows[0];
    if (primary) {
      const others = summary.windows.filter((window) => window !== primary);
      return evaluateQuotaAvailability({
        credits: {
          periodType: primary.periodType,
          usedPercent: primary.usedPercent,
          ...(primary.resetsAt ? { resetsAt: primary.resetsAt } : {}),
          ...(primary.scopeId
            ? { scope: { id: primary.scopeId, label: primary.scopeLabel ?? primary.scopeId } }
            : {}),
          ...(primary.label ? { label: primary.label } : {}),
          ...(others.length > 0
            ? {
                productUsage: others.map((window) => ({
                  product: window.label ?? window.periodType,
                  periodType: window.periodType,
                  usagePercent: window.usedPercent,
                  ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
                  ...(window.scopeId
                    ? { scope: { id: window.scopeId, label: window.scopeLabel ?? window.scopeId } }
                    : {}),
                })),
              }
            : {}),
        },
        harnessId: options.harnessId,
        ...(options.scopeId ? { scopeId: options.scopeId } : {}),
        minHeadroomPercent: options.minHeadroomPercent,
      });
    }
  }
  return {
    status: summary.status,
    windows: summary.windows,
    blockingWindows: summary.blockingWindows,
    blockingPeriods: summary.blockingPeriods,
    ...(summary.minRemainingPercent !== undefined
      ? { minRemainingPercent: summary.minRemainingPercent }
      : {}),
    ...(summary.earliestUnblockAt ? { earliestUnblockAt: summary.earliestUnblockAt } : {}),
    allBlockingResetsKnown: summary.allBlockingResetsKnown,
  };
}

function inferredPrimaryScope(summary: HarnessQuotaSummary | undefined): string | undefined {
  if (!summary) return undefined;
  const primary = summary.windows.find((window) => window.isPrimary);
  if (!primary?.scopeId) return undefined;
  return primary.scopeId.trim().toLowerCase() === summary.harnessId.trim().toLowerCase()
    ? undefined
    : primary.scopeId;
}

/**
 * Coordinates opt-in automatic Thread continuation after 5-hour or weekly quota resets across
 * multiple Harnesses. Built purely on public `read`, `send` and `quota` operations:
 * - Evaluates all applicable windows (`MAX(resetsAt)`) so a 5h reset never fires while 7d is full.
 * - Verifies live quota after `resetsAt + grace` via single-flight coalesced refreshes per Harness.
 * - Serializes wakeups within each quota pool (priority + FIFO, bounded concurrency, headroom guard)
 *   to prevent thundering herds across Threads or Harnesses sharing a Billing Source.
 * - Survives Host restarts and OS sleep, works with idle session release, and auto-cancels on user
 *   activity, `thread cancel`, or unanswered Questions.
 */
export class QuotaContinuationService {
  readonly #api: Pick<DelegationControlApi, "read" | "send" | "quota">;
  readonly #store: QuotaContinuationStore | undefined;
  readonly #diagnose: (error: unknown) => void;
  readonly #now: () => number;
  readonly #maxTimerSliceMs: number;
  readonly #refreshCooldownMs: number;
  readonly #verifyBackoffBaseMs: number;
  readonly #verifyBackoffMaxMs: number;
  readonly #restoreGraceMs: number;
  readonly #onUnblocked: ((threadId: string) => void) | undefined;
  readonly #ready: Promise<void>;
  readonly #entries: Entry[] = [];
  readonly #refreshCache = new Map<string, RefreshCacheEntry>();
  readonly #refreshFlights = new Map<string, Promise<HarnessQuotaListResult | null>>();
  readonly #activePoolThreads = new Map<string, Set<string>>();
  readonly #poolDirtySinceRefresh = new Set<string>();
  readonly #dispatchingThreads = new Set<string>();
  #writes: Promise<void> = Promise.resolve();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #ticking = false;
  #nudgePending = false;
  #closed = false;

  constructor(
    api: Pick<DelegationControlApi, "read" | "send" | "quota">,
    options: {
      store?: QuotaContinuationStore;
      diagnose?: (error: unknown) => void;
      now?: () => number;
      maxTimerSliceMs?: number;
      refreshCooldownMs?: number;
      verifyBackoffBaseMs?: number;
      verifyBackoffMaxMs?: number;
      restoreGraceMs?: number;
      onUnblocked?: (threadId: string) => void;
    } = {},
  ) {
    this.#api = api;
    this.#store = options.store;
    this.#diagnose = options.diagnose ?? (() => undefined);
    this.#now = options.now ?? Date.now;
    this.#maxTimerSliceMs = options.maxTimerSliceMs ?? MAX_TIMER_SLICE_MS;
    this.#refreshCooldownMs = options.refreshCooldownMs ?? DEFAULT_REFRESH_COOLDOWN_MS;
    this.#verifyBackoffBaseMs = options.verifyBackoffBaseMs ?? DEFAULT_VERIFY_BACKOFF_BASE_MS;
    this.#verifyBackoffMaxMs = options.verifyBackoffMaxMs ?? DEFAULT_VERIFY_BACKOFF_MAX_MS;
    this.#restoreGraceMs = options.restoreGraceMs ?? DEFAULT_RESTORE_GRACE_MS;
    this.#onUnblocked = options.onUnblocked;
    this.#ready = this.#store ? this.#restore(this.#store) : Promise.resolve();
  }

  /** True when the Thread is actively waiting for quota refresh and should defer watch wakes. */
  isThreadDeferredForQuota(threadId: string): boolean {
    return this.#entries.some(
      (entry) => entry.threadId === threadId && isDeferredForQuotaState(entry.state),
    );
  }

  /** True while this service itself is submitting a continuation `send` on `threadId`. */
  isDispatching(threadId: string): boolean {
    return this.#dispatchingThreads.has(threadId);
  }

  async continueOnReset(input: ThreadContinueOnResetInput): Promise<ThreadContinueOnResetResult> {
    await this.#ready;
    if (this.#closed) throw new DelegationControlError("INTERNAL_ERROR", "Host Runtime is closing");
    if (typeof input.threadId !== "string" || !input.threadId.trim())
      throw new DelegationControlError("INVALID_ARGUMENT", "Thread identifier is required");
    const prompt = input.prompt ?? DEFAULT_QUOTA_CONTINUATION_PROMPT;
    if (typeof prompt !== "string" || !prompt.trim())
      throw new DelegationControlError("INVALID_ARGUMENT", "prompt must not be empty");
    if (Buffer.byteLength(prompt, "utf8") > MAX_CLI_TEXT_INPUT_BYTES)
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        `prompt exceeds ${MAX_CLI_TEXT_INPUT_BYTES} bytes (256 KiB)`,
      );
    const scopeId = input.scopeId?.trim() || undefined;
    if (input.scopeId !== undefined && !scopeId)
      throw new DelegationControlError("INVALID_ARGUMENT", "scopeId must be a non-empty string");
    const explicitPoolKey = input.poolKey?.trim() || undefined;
    if (input.poolKey !== undefined && !explicitPoolKey)
      throw new DelegationControlError("INVALID_ARGUMENT", "poolKey must be a non-empty string");
    const priority = input.priority ?? 0;
    if (!Number.isSafeInteger(priority))
      throw new DelegationControlError("INVALID_ARGUMENT", "priority must be an integer");
    const maxWaitMs = input.maxWaitMs ?? DEFAULT_QUOTA_CONTINUATION_MAX_WAIT_MS;
    if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs <= 0)
      throw new DelegationControlError("INVALID_ARGUMENT", "maxWaitMs must be a positive integer");
    const minHeadroomPercent = input.minHeadroomPercent ?? 0;
    if (
      typeof minHeadroomPercent !== "number" ||
      !Number.isFinite(minHeadroomPercent) ||
      minHeadroomPercent < 0 ||
      minHeadroomPercent > 99
    )
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "minHeadroomPercent must be a number between 0 and 99",
      );
    const maxConcurrentPerPool = input.maxConcurrentPerPool ?? 1;
    if (
      !Number.isSafeInteger(maxConcurrentPerPool) ||
      maxConcurrentPerPool < 1 ||
      maxConcurrentPerPool > MAX_CONCURRENT_PER_POOL
    )
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        `maxConcurrentPerPool must be an integer between 1 and ${MAX_CONCURRENT_PER_POOL}`,
      );
    const resetGraceMs = input.resetGraceMs ?? DEFAULT_QUOTA_RESET_GRACE_MS;
    if (
      !Number.isSafeInteger(resetGraceMs) ||
      resetGraceMs < 0 ||
      resetGraceMs > MAX_RESET_GRACE_MS
    )
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        `resetGraceMs must be an integer between 0 and ${MAX_RESET_GRACE_MS}`,
      );
    const waitUntilMs = input.waitUntil !== undefined ? Date.parse(input.waitUntil) : undefined;
    if (input.waitUntil !== undefined && !Number.isFinite(waitUntilMs))
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "waitUntil must be a valid ISO-8601 timestamp",
      );

    const target = await this.#api.read({ threadId: input.threadId, view: "result" });
    if (target.status === "running" || target.status === "creating")
      throw new DelegationControlError(
        "THREAD_BUSY",
        "Thread is currently running; schedule quota continuation after it stops",
      );
    if (target.pendingQuestions?.length)
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "Thread has unanswered questions; answer them before scheduling quota continuation",
      );

    const now = this.#now();
    const quotaList = this.#api.quota
      ? await this.#api.quota({ refresh: true }).catch(() => null)
      : null;
    const summary = quotaList?.harnesses.find((item) => item.harnessId === target.harnessId);
    const effectiveScopeId = scopeId ?? inferredPrimaryScope(summary);
    const poolKey = deriveQuotaPoolKey({
      harnessId: target.harnessId,
      ...(effectiveScopeId ? { scopeId: effectiveScopeId } : {}),
      ...(explicitPoolKey ? { poolKey: explicitPoolKey } : {}),
    });
    const evaluation = evaluateSummary(summary, {
      harnessId: target.harnessId,
      ...(effectiveScopeId ? { scopeId: effectiveScopeId } : {}),
      minHeadroomPercent,
    });
    const alternatives = quotaList
      ? rankAlternativeHarnesses(quotaList.harnesses, { harnessId: target.harnessId, poolKey })
      : [];

    if (evaluation.status === "prepaidOnly" && waitUntilMs === undefined) {
      throw new DelegationControlError(
        "UNSUPPORTED",
        `Harness '${target.harnessId}' reports a prepaid balance without a reset window; auto-continuation applies only to windowed plan quotas`,
      );
    }

    if (evaluation.status === "available" && waitUntilMs === undefined) {
      return {
        threadId: target.threadId,
        harnessId: target.harnessId,
        poolKey,
        state: "alreadyAvailable",
        ...(alternatives.length ? { availableAlternatives: alternatives } : {}),
      };
    }

    const evalResetMs = evaluation.earliestUnblockAt
      ? Date.parse(evaluation.earliestUnblockAt)
      : Number.NaN;
    let targetResetAtMs: number | undefined;
    if (Number.isFinite(evalResetMs) && waitUntilMs !== undefined) {
      targetResetAtMs = Math.max(evalResetMs, waitUntilMs);
    } else if (Number.isFinite(evalResetMs)) {
      targetResetAtMs = evalResetMs;
    } else if (waitUntilMs !== undefined) {
      targetResetAtMs = waitUntilMs;
    }

    if (targetResetAtMs === undefined) {
      throw new DelegationControlError(
        "UNSUPPORTED",
        `No quota reset time is currently reported for Harness '${target.harnessId}'; pass waitUntil explicitly if known`,
      );
    }

    const targetResetAt = new Date(targetResetAtMs).toISOString();
    const deadlineMs = now + maxWaitMs;
    if (targetResetAtMs > deadlineMs) {
      return {
        threadId: target.threadId,
        harnessId: target.harnessId,
        poolKey,
        state: "exceedsMaxWait",
        targetResetAt,
        ...(evaluation.blockingPeriods.length
          ? { blockingPeriods: evaluation.blockingPeriods }
          : {}),
        ...(alternatives.length ? { availableAlternatives: alternatives } : {}),
        reason: "Next quota reset exceeds maxWaitMs",
      };
    }

    if (this.#closed) throw new DelegationControlError("INTERNAL_ERROR", "Host Runtime is closing");
    // Replace any prior active continuation on this Thread so re-scheduling stays idempotent.
    for (const existing of [...this.#entries]) {
      if (existing.threadId === target.threadId && isActiveState(existing.state)) {
        this.#remove(existing);
      }
    }

    const nextCheckAtMs = Math.max(now, targetResetAtMs + resetGraceMs);
    const entry: Entry = {
      id: randomUUID(),
      threadId: target.threadId,
      harnessId: target.harnessId,
      poolKey,
      ...(effectiveScopeId ? { scopeId: effectiveScopeId } : {}),
      state: "waitingForReset",
      priority,
      registeredAt: new Date(now).toISOString(),
      targetResetAt,
      targetResetAtMs,
      deadlineAt: new Date(deadlineMs).toISOString(),
      deadlineMs,
      nextCheckAt: new Date(nextCheckAtMs).toISOString(),
      nextCheckAtMs,
      minHeadroomPercent,
      maxConcurrentPerPool,
      resetGraceMs,
      prompt,
      ...(target.turn?.turnId ? { baselineTurnId: target.turn.turnId } : {}),
      ...(target.title ? { taskName: target.title } : {}),
      ...(evaluation.blockingPeriods.length ? { blockingPeriods: evaluation.blockingPeriods } : {}),
      ...(alternatives.length ? { availableAlternatives: alternatives } : {}),
      ...(waitUntilMs !== undefined ? { explicitWaitUntil: true } : {}),
    };

    this.#entries.push(entry);
    try {
      await this.#persist(entry, true);
    } catch (error) {
      const index = this.#entries.indexOf(entry);
      if (index >= 0) this.#entries.splice(index, 1);
      throw new DelegationControlError(
        "INTERNAL_ERROR",
        `Could not persist quota continuation: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.#schedule();
    return {
      id: entry.id,
      threadId: entry.threadId,
      harnessId: entry.harnessId,
      poolKey: entry.poolKey,
      state: "waitingForReset",
      targetResetAt,
      ...(entry.blockingPeriods?.length ? { blockingPeriods: entry.blockingPeriods } : {}),
      ...(alternatives.length ? { availableAlternatives: alternatives } : {}),
    };
  }

  async continuations(): Promise<ThreadContinuationListResult> {
    await this.#ready;
    const entries = [...this.#entries];
    const snapshots = new Map<string, DelegationThreadSnapshot | undefined>();
    await Promise.all(
      [...new Set(entries.map(({ threadId }) => threadId))].map(async (threadId) => {
        try {
          snapshots.set(threadId, await this.#api.read({ threadId, view: "result" }));
        } catch {
          // A missing or temporarily unreadable Thread must not hide its continuation record.
        }
      }),
    );
    return {
      continuations: entries
        .filter((entry) => this.#entries.includes(entry))
        .map((entry) => publicEntry(entry, snapshots.get(entry.threadId))),
    };
  }

  async cancelContinuation(
    input: ThreadContinueCancelInput,
    reason = "Cancelled",
  ): Promise<ThreadContinueCancelResult> {
    await this.#ready;
    if (typeof input.threadId !== "string" || !input.threadId.trim())
      throw new DelegationControlError("INVALID_ARGUMENT", "Thread identifier is required");
    const matching = this.#entries.filter(
      (entry) => entry.threadId === input.threadId && isActiveState(entry.state),
    );
    if (matching.length === 0) {
      return { threadId: input.threadId, cancelled: false, cancelledCount: 0 };
    }
    for (const entry of matching) {
      this.#finish(entry, "cancelled", reason);
    }
    this.#trimTerminal();
    await this.#writes;
    return { threadId: input.threadId, cancelled: true, cancelledCount: matching.length };
  }

  /** Called when a Thread stops so staggered pool members can be admitted promptly. */
  nudge(threadId?: string): void {
    if (this.#closed) return;
    if (threadId) {
      for (const members of this.#activePoolThreads.values()) members.delete(threadId);
    }
    if (!this.#entries.some((entry) => isActiveState(entry.state))) return;
    if (this.#ticking) {
      this.#nudgePending = true;
      return;
    }
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#schedule(0);
  }

  close(): void {
    this.#closed = true;
    this.#nudgePending = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#entries.length = 0;
    this.#activePoolThreads.clear();
    this.#refreshCache.clear();
    this.#refreshFlights.clear();
  }

  async #restore(store: QuotaContinuationStore): Promise<void> {
    let records: PersistedQuotaContinuation[];
    try {
      records = await store.adopt();
    } catch (error) {
      this.#diagnose(error);
      return;
    }
    if (this.#closed) return;
    const now = this.#now();
    const graceUntil = now + this.#restoreGraceMs;
    for (const record of records) {
      const entry: Entry = { ...record };
      if (entry.dispatching) {
        // Sending may already have started a Turn before the crash; do not duplicate side effects.
        delete entry.dispatching;
        entry.state = "failed";
        entry.reason =
          "Host Runtime restarted while continuation dispatch was in progress; verify the Thread before continuing";
      } else if (isActiveState(entry.state)) {
        if (now >= entry.deadlineMs) {
          entry.state = "expired";
          entry.reason = "Continuation wait window expired while the Host Runtime was stopped";
        } else {
          entry.restoreGraceUntil = graceUntil;
          if (entry.nextCheckAtMs === undefined || entry.nextCheckAtMs < now) {
            entry.nextCheckAtMs = now;
            entry.nextCheckAt = new Date(now).toISOString();
          }
        }
      }
      this.#entries.push(entry);
      if (record.dispatching || entry.state !== record.state) void this.#persist(entry);
    }
    this.#trimTerminal();
    if (records.length > 0)
      this.#diagnose(`restored ${records.length} quota continuation(s) after a restart`);
    this.#schedule();
  }

  #schedule(explicitDelayMs?: number): void {
    if (this.#closed || this.#timer) return;
    const active = this.#entries.filter((entry) => isActiveState(entry.state));
    if (active.length === 0) return;

    let delayMs: number;
    if (explicitDelayMs !== undefined) {
      delayMs = Math.max(0, explicitDelayMs);
    } else if (active.some((entry) => entry.state === "readyToResume")) {
      delayMs = Math.min(this.#verifyBackoffBaseMs, this.#maxTimerSliceMs);
    } else {
      const now = this.#now();
      const earliest = Math.min(
        ...active.map((entry) =>
          Math.min(entry.deadlineMs, entry.nextCheckAtMs ?? entry.deadlineMs),
        ),
      );
      delayMs = Math.min(Math.max(0, earliest - now), this.#maxTimerSliceMs);
    }

    this.#timer = setTimeout(() => {
      this.#ticking = true;
      this.#nudgePending = false;
      void this.#tick()
        .catch((error: unknown) => this.#diagnose(error))
        .finally(() => {
          this.#ticking = false;
          this.#timer = undefined;
          const immediate = this.#nudgePending;
          this.#nudgePending = false;
          this.#schedule(immediate ? 0 : undefined);
        });
    }, delayMs);
    this.#timer.unref?.();
  }

  async #tick(): Promise<void> {
    const now = this.#now();
    // Phase 1: check due waiting/verifying entries.
    for (const entry of [...this.#entries]) {
      if (this.#closed) return;
      if (entry.state !== "waitingForReset" && entry.state !== "verifying") continue;
      if (now >= entry.deadlineMs) {
        await this.#expire(entry, "Wait window expired before quota refreshed");
        continue;
      }
      if ((entry.nextCheckAtMs ?? 0) > now) continue;
      await this.#verifyEntry(entry);
    }

    // Phase 2: admit ready entries per pool with priority + FIFO ordering and headroom guards.
    const readyByPool = new Map<string, Entry[]>();
    for (const entry of this.#entries) {
      if (entry.state !== "readyToResume") continue;
      if (this.#now() >= entry.deadlineMs) {
        await this.#expire(entry, "Wait window expired before continuation could be dispatched");
        continue;
      }
      const list = readyByPool.get(entry.poolKey) ?? [];
      list.push(entry);
      readyByPool.set(entry.poolKey, list);
    }

    for (const [poolKey, candidates] of readyByPool) {
      if (this.#closed) return;
      await this.#admitPool(poolKey, candidates);
    }
    this.#trimTerminal();
  }

  async #verifyEntry(entry: Entry): Promise<void> {
    const threadOk = await this.#checkThreadStillEligible(entry);
    if (!threadOk || !isActiveState(entry.state)) return;

    const now = this.#now();
    if (!this.#api.quota) {
      if (entry.explicitWaitUntil && now >= (entry.targetResetAtMs ?? 0) + entry.resetGraceMs) {
        this.#markReady(entry);
      } else {
        this.#scheduleVerifyBackoff(entry);
      }
      return;
    }

    const quota = await this.#refreshHarnessQuota(entry.harnessId, false);
    const summary = quota?.harnesses.find((item) => item.harnessId === entry.harnessId);
    const evaluation = evaluateSummary(summary, {
      harnessId: entry.harnessId,
      ...(entry.scopeId ? { scopeId: entry.scopeId } : {}),
      minHeadroomPercent: entry.minHeadroomPercent,
    });

    if (evaluation.status === "prepaidOnly") {
      this.#finish(
        entry,
        "cancelled",
        "Harness switched to prepaid balance without a reset window",
      );
      return;
    }

    if (evaluation.status === "available") {
      this.#markReady(entry);
      return;
    }

    if (evaluation.status === "exhausted") {
      entry.blockingPeriods = evaluation.blockingPeriods;
      const newResetMs = evaluation.earliestUnblockAt
        ? Date.parse(evaluation.earliestUnblockAt)
        : Number.NaN;
      if (Number.isFinite(newResetMs) && newResetMs > (entry.targetResetAtMs ?? 0)) {
        entry.targetResetAtMs = newResetMs;
        entry.targetResetAt = new Date(newResetMs).toISOString();
        if (newResetMs > entry.deadlineMs) {
          await this.#expire(entry, "A longer quota window remains exhausted beyond maxWaitMs");
          return;
        }
        entry.state = "waitingForReset";
        entry.verifyAttempt = 0;
        const nextCheckAtMs = Math.max(this.#now(), newResetMs + entry.resetGraceMs);
        entry.nextCheckAtMs = nextCheckAtMs;
        entry.nextCheckAt = new Date(nextCheckAtMs).toISOString();
        await this.#persist(entry);
        return;
      }
      this.#scheduleVerifyBackoff(entry);
      return;
    }

    // Status is "unknown": if explicit waitUntil elapsed, resume; otherwise retry with backoff.
    if (entry.explicitWaitUntil && now >= (entry.targetResetAtMs ?? 0) + entry.resetGraceMs) {
      this.#markReady(entry);
      return;
    }
    this.#scheduleVerifyBackoff(entry);
  }

  async #admitPool(poolKey: string, candidates: Entry[]): Promise<void> {
    candidates.sort(
      (left, right) =>
        right.priority - left.priority ||
        left.registeredAt.localeCompare(right.registeredAt) ||
        left.id.localeCompare(right.id),
    );

    const active = await this.#reconcileActivePoolThreads(poolKey);
    const poolLimit = Math.min(...candidates.map((candidate) => candidate.maxConcurrentPerPool));

    for (const entry of candidates) {
      if (this.#closed || entry.state !== "readyToResume") continue;
      if (active.size >= Math.min(poolLimit, entry.maxConcurrentPerPool)) break;

      const eligible = await this.#checkThreadStillEligible(entry);
      if (!eligible || entry.state !== "readyToResume") continue;

      // Re-verify pool headroom after an earlier Thread in the same pool consumed fresh quota.
      if (this.#poolDirtySinceRefresh.has(poolKey) && this.#api.quota) {
        const fresh = await this.#refreshHarnessQuota(entry.harnessId, true);
        this.#poolDirtySinceRefresh.delete(poolKey);
        const summary = fresh?.harnesses.find((item) => item.harnessId === entry.harnessId);
        const evaluation = evaluateSummary(summary, {
          harnessId: entry.harnessId,
          ...(entry.scopeId ? { scopeId: entry.scopeId } : {}),
          minHeadroomPercent: entry.minHeadroomPercent,
        });
        if (evaluation.status === "exhausted") {
          entry.blockingPeriods = evaluation.blockingPeriods;
          const nextResetMs = evaluation.earliestUnblockAt
            ? Date.parse(evaluation.earliestUnblockAt)
            : Number.NaN;
          if (Number.isFinite(nextResetMs)) {
            entry.targetResetAtMs = nextResetMs;
            entry.targetResetAt = new Date(nextResetMs).toISOString();
            if (nextResetMs > entry.deadlineMs) {
              await this.#expire(
                entry,
                "Pool headroom dropped below minHeadroomPercent and next reset exceeds maxWaitMs",
              );
              continue;
            }
            entry.state = "waitingForReset";
            entry.verifyAttempt = 0;
            const nextCheckAtMs = Math.max(this.#now(), nextResetMs + entry.resetGraceMs);
            entry.nextCheckAtMs = nextCheckAtMs;
            entry.nextCheckAt = new Date(nextCheckAtMs).toISOString();
            await this.#persist(entry);
          } else {
            this.#scheduleVerifyBackoff(entry);
          }
          break;
        }
      }

      entry.dispatching = true;
      await this.#persist(entry);
      this.#dispatchingThreads.add(entry.threadId);
      try {
        const result = await this.#api.send({ threadId: entry.threadId, message: entry.prompt });
        delete entry.dispatching;
        entry.state = "resumed";
        entry.resumedAt = new Date(this.#now()).toISOString();
        entry.resumedTurnId = result.turnId;
        delete entry.nextCheckAt;
        delete entry.nextCheckAtMs;
        await this.#persist(entry);
        active.add(entry.threadId);
        this.#activePoolThreads.set(poolKey, active);
        this.#poolDirtySinceRefresh.add(poolKey);
        this.#onUnblocked?.(entry.threadId);
      } catch (error) {
        delete entry.dispatching;
        const kind = dispatchFailure(error);
        const message = error instanceof Error ? error.message : String(error);
        if (kind === "permanent") {
          this.#finish(entry, "failed", message);
        } else if (kind === "rejected") {
          await this.#persist(entry);
          // Re-check on next tick (or cancel if user took over the Thread).
          await this.#checkThreadStillEligible(entry);
        } else {
          this.#finish(
            entry,
            "failed",
            `Dispatch outcome unknown; the continuation may already have started a Turn, so it is not retried (${message})`,
          );
        }
      } finally {
        this.#dispatchingThreads.delete(entry.threadId);
      }
    }
  }

  async #reconcileActivePoolThreads(poolKey: string): Promise<Set<string>> {
    const active = this.#activePoolThreads.get(poolKey) ?? new Set<string>();
    for (const threadId of [...active]) {
      try {
        const snapshot = await this.#api.read({ threadId, view: "result" });
        if (snapshot.status !== "running" && snapshot.status !== "creating") {
          active.delete(threadId);
        }
      } catch {
        active.delete(threadId);
      }
    }
    if (active.size === 0) this.#activePoolThreads.delete(poolKey);
    return active;
  }

  async #checkThreadStillEligible(entry: Entry): Promise<boolean> {
    try {
      const snapshot = await this.#api.read({ threadId: entry.threadId, view: "result" });
      delete entry.restoreGraceUntil;
      if (snapshot.title) entry.taskName = snapshot.title;
      if (snapshot.status === "running" || snapshot.status === "creating") {
        this.#finish(entry, "cancelled", "Thread became active while waiting for quota reset");
        return false;
      }
      const currentTurnId = snapshot.turn?.turnId;
      if (
        (entry.baselineTurnId && currentTurnId && currentTurnId !== entry.baselineTurnId) ||
        (!entry.baselineTurnId && currentTurnId)
      ) {
        this.#finish(entry, "cancelled", "Thread had newer activity while waiting for quota reset");
        return false;
      }
      if (snapshot.pendingQuestions?.length) {
        this.#finish(entry, "cancelled", "Thread has unanswered questions");
        return false;
      }
      return true;
    } catch (error) {
      if (entry.restoreGraceUntil !== undefined) {
        if (this.#now() < entry.restoreGraceUntil) return false;
        delete entry.restoreGraceUntil;
      }
      if (errorCode(error) === "THREAD_NOT_FOUND") {
        this.#finish(entry, "cancelled", "Thread no longer exists");
        return false;
      }
      return false;
    }
  }

  /** Coalesces concurrent refreshes per Harness so multiple waiting Threads trigger one probe. */
  async #refreshHarnessQuota(
    harnessId: RoutedHarnessId,
    bypassCooldown: boolean,
  ): Promise<HarnessQuotaListResult | null> {
    if (!this.#api.quota) return null;
    const now = this.#now();
    const cached = this.#refreshCache.get(harnessId);
    if (!bypassCooldown && cached && now - cached.fetchedAt < this.#refreshCooldownMs) {
      return cached.result;
    }
    const existing = this.#refreshFlights.get(harnessId);
    if (!bypassCooldown && existing) return existing;
    const flight = this.#api
      .quota({ harnessId, refresh: true })
      .then((result) => {
        this.#refreshCache.set(harnessId, { fetchedAt: this.#now(), result });
        return result;
      })
      .catch(() => null)
      .finally(() => {
        if (this.#refreshFlights.get(harnessId) === flight) {
          this.#refreshFlights.delete(harnessId);
        }
      });
    this.#refreshFlights.set(harnessId, flight);
    return flight;
  }

  #markReady(entry: Entry): void {
    entry.state = "readyToResume";
    entry.verifyAttempt = 0;
    delete entry.blockingPeriods;
    delete entry.nextCheckAt;
    delete entry.nextCheckAtMs;
    void this.#persist(entry);
  }

  #scheduleVerifyBackoff(entry: Entry): void {
    const attempt = (entry.verifyAttempt ?? 0) + 1;
    entry.verifyAttempt = attempt;
    entry.state = "verifying";
    const backoff = Math.min(
      this.#verifyBackoffBaseMs * 2 ** (attempt - 1),
      this.#verifyBackoffMaxMs,
    );
    const nextCheckAtMs = Math.min(this.#now() + backoff, entry.deadlineMs);
    entry.nextCheckAtMs = nextCheckAtMs;
    entry.nextCheckAt = new Date(nextCheckAtMs).toISOString();
    void this.#persist(entry);
  }

  async #expire(entry: Entry, reason: string): Promise<void> {
    if (this.#api.quota) {
      const all = await this.#api.quota({ refresh: false }).catch(() => null);
      if (all) {
        const alternatives = rankAlternativeHarnesses(all.harnesses, {
          harnessId: entry.harnessId,
          poolKey: entry.poolKey,
        });
        if (alternatives.length > 0) entry.availableAlternatives = alternatives;
      }
    }
    this.#finish(entry, "expired", reason);
  }

  #finish(entry: Entry, state: "cancelled" | "expired" | "failed", reason: string): void {
    const wasDeferred = isDeferredForQuotaState(entry.state);
    entry.state = state;
    entry.reason = reason;
    delete entry.nextCheckAt;
    delete entry.nextCheckAtMs;
    void this.#persist(entry);
    if (wasDeferred) this.#onUnblocked?.(entry.threadId);
  }

  #persist(entry: Entry, required = false): Promise<void> {
    if (!this.#entries.includes(entry)) return Promise.resolve();
    const record = persisted(entry);
    return this.#write((store) => store.save(record), required);
  }

  #write(
    operation: (store: QuotaContinuationStore) => Promise<void>,
    required = false,
  ): Promise<void> {
    const store = this.#store;
    if (!store) return Promise.resolve();
    const next = this.#writes.then(() => operation(store));
    this.#writes = next.catch((error: unknown) => this.#diagnose(error));
    return required ? next : this.#writes;
  }

  #remove(entry: Entry): void {
    const index = this.#entries.indexOf(entry);
    if (index >= 0) this.#entries.splice(index, 1);
    void this.#write((store) => store.remove(entry.id));
  }

  #trimTerminal(): void {
    const terminalEntries = this.#entries.filter((entry) => !isActiveState(entry.state));
    for (const entry of terminalEntries.slice(0, -MAX_TERMINAL_ENTRIES)) this.#remove(entry);
  }
}
