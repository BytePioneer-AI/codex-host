import { setTimeout as delay } from "node:timers/promises";

import {
  DelegationControlError,
  type DelegationThreadStatus,
  type ThreadWaitManyInput,
  type ThreadWaitManyResult,
  type ThreadWaitManyStatusView,
  type ThreadWaitManyTarget,
  type ThreadWaitManyTargetResult,
} from "./delegation-types.js";

export const DEFAULT_OBSERVE_TIMEOUT_MS = 300_000;
export const MAX_OBSERVE_TIMEOUT_MS = 3_600_000;
const REQUEST_TIMEOUT_MS = 60_000;

export interface ThreadObserveTarget extends ThreadWaitManyTarget {
  expectedTurnId?: string;
  /** Absolute ISO timestamp; this is a review deadline, never a child cancellation. */
  reviewAt?: string;
}

export interface ThreadObserveEvent {
  threadId: string;
  reason: "terminal" | "needs-input" | "turn-changed" | "resync" | "error" | "review-due";
  error?: { code: string; message: string };
}

export interface ThreadObserveResult {
  reason: "attention" | "review-due" | "timeout" | "cancelled";
  events: ThreadObserveEvent[];
  targets: ThreadObserveTarget[];
  statuses: ThreadWaitManyStatusView[];
  /** Older Runtimes and official Threads do not expose pending Host Interactions. */
  inputVisibilityUnavailable: string[];
  elapsedMs: number;
  requests: number;
  suppressedChanges: number;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function parseObserveTargets(value: unknown): ThreadObserveTarget[] {
  const invalid = () => new DelegationControlError("INVALID_ARGUMENT", "Invalid observe targets");
  if (!Array.isArray(value) || value.length === 0) throw invalid();
  const ids = new Set<string>();
  return value.map((row: unknown) => {
    if (!object(row) || !nonempty(row.threadId)) throw invalid();
    if (
      Object.keys(row).some(
        (key) => !["threadId", "afterRevision", "expectedTurnId", "reviewAt"].includes(key),
      )
    )
      throw invalid();
    const threadId = row.threadId.replace(/^codex:\/\/threads\//u, "");
    if (!threadId || /[/?\s]/u.test(threadId) || ids.has(threadId)) throw invalid();
    ids.add(threadId);
    for (const key of ["afterRevision", "expectedTurnId", "reviewAt"] as const) {
      if (row[key] !== undefined && !nonempty(row[key])) throw invalid();
    }
    if (
      row.reviewAt !== undefined &&
      (!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/u.test(String(row.reviewAt)) ||
        !Number.isFinite(Date.parse(String(row.reviewAt))))
    )
      throw invalid();
    return {
      threadId,
      ...(row.afterRevision !== undefined ? { afterRevision: row.afterRevision as string } : {}),
      ...(row.expectedTurnId !== undefined ? { expectedTurnId: row.expectedTurnId as string } : {}),
      ...(row.reviewAt !== undefined ? { reviewAt: row.reviewAt as string } : {}),
    };
  });
}

function status(value: unknown): value is DelegationThreadStatus {
  return ["creating", "running", "completed", "failed", "interrupted"].includes(String(value));
}

/** Validate the transport boundary and retain only compact fields, never arbitrary response bodies. */
function parseSnapshot(value: unknown, targets: ThreadObserveTarget[]): ThreadWaitManyResult {
  const invalid = () => new DelegationControlError("INTERNAL_ERROR", "Invalid wait-many response");
  if (!object(value) || typeof value.timedOut !== "boolean" || !Array.isArray(value.results))
    throw invalid();
  const pending = new Set(targets.map((target) => target.threadId));
  const results: ThreadWaitManyTargetResult[] = value.results.map((row: unknown) => {
    if (!object(row) || typeof row.threadId !== "string" || !pending.delete(row.threadId))
      throw invalid();
    if (row.outcome === "error") {
      if (!object(row.error) || !nonempty(row.error.code) || typeof row.error.message !== "string")
        throw invalid();
      return {
        threadId: row.threadId,
        outcome: "error",
        error: {
          code: row.error.code as DelegationControlError["code"],
          message: row.error.message,
        },
      };
    }
    const view = row.status;
    if (
      !["changed", "timedOut", "resync"].includes(String(row.outcome)) ||
      !nonempty(row.revision) ||
      !object(view) ||
      view.threadId !== row.threadId ||
      view.revision !== row.revision ||
      !nonempty(view.harnessId) ||
      !status(view.status)
    )
      throw invalid();
    if (
      view.turn !== null &&
      (!object(view.turn) || !nonempty(view.turn.turnId) || !status(view.turn.status))
    )
      throw invalid();
    if (
      view.pendingInteractions !== undefined &&
      (!Number.isSafeInteger(view.pendingInteractions) || Number(view.pendingInteractions) < 0)
    )
      throw invalid();
    return {
      threadId: row.threadId,
      outcome: row.outcome as "changed" | "timedOut" | "resync",
      revision: row.revision,
      status: {
        threadId: row.threadId,
        harnessId: view.harnessId as ThreadWaitManyStatusView["harnessId"],
        status: view.status,
        turn:
          view.turn === null
            ? null
            : {
                turnId: (view.turn as { turnId: string }).turnId,
                status: (view.turn as { status: DelegationThreadStatus }).status,
              },
        revision: row.revision,
        ...(view.pendingInteractions !== undefined
          ? { pendingInteractions: Number(view.pendingInteractions) }
          : {}),
      },
    };
  });
  if (pending.size) throw invalid();
  return { timedOut: value.timedOut, results };
}

/** A read-only client loop: no model calls, child control, or business-state writes. */
export async function observeThreads(input: {
  targets: ThreadObserveTarget[];
  timeoutMs: number;
  signal?: AbortSignal;
  waitMany(input: ThreadWaitManyInput, signal: AbortSignal): Promise<unknown>;
}): Promise<ThreadObserveResult> {
  const targets = parseObserveTargets(input.targets);
  if (
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 0 ||
    input.timeoutMs > MAX_OBSERVE_TIMEOUT_MS
  )
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      `Observe timeout must be between 0 and ${MAX_OBSERVE_TIMEOUT_MS}`,
    );
  const byId = new Map(targets.map((target) => [target.threadId, target]));
  const started = performance.now();
  const statuses = new Map<string, ThreadWaitManyStatusView>();
  let requests = 0;
  let suppressedChanges = 0;
  let failures = 0;
  const elapsed = () => Math.round(performance.now() - started);
  const finish = (
    reason: ThreadObserveResult["reason"],
    events: ThreadObserveEvent[] = [],
  ): ThreadObserveResult => ({
    reason,
    events,
    targets,
    statuses: [...statuses.values()],
    elapsedMs: elapsed(),
    requests,
    suppressedChanges,
    inputVisibilityUnavailable: targets
      .filter((target) => statuses.get(target.threadId)?.pendingInteractions === undefined)
      .map((target) => target.threadId),
  });
  while (true) {
    if (input.signal?.aborted) return finish("cancelled");
    const due = targets.filter(
      (target) => target.reviewAt !== undefined && Date.parse(target.reviewAt) <= Date.now(),
    );
    if (due.length)
      return finish(
        "review-due",
        due.map(({ threadId }) => ({ threadId, reason: "review-due" })),
      );
    const remaining = input.timeoutMs - elapsed();
    if (requests > 0 && remaining <= 0) return finish("timeout");
    const reviewRemaining = Math.min(
      ...targets.map((target) =>
        target.reviewAt === undefined ? Infinity : Date.parse(target.reviewAt) - Date.now(),
      ),
    );
    const timeoutMs =
      requests === 0 ? 0 : Math.max(0, Math.min(REQUEST_TIMEOUT_MS, remaining, reviewRemaining));
    // Bound a stalled transport as well as normal server waits. No timeout affects the child Turn.
    const requestDeadline = AbortSignal.timeout(
      input.timeoutMs === 0
        ? 5_000
        : Math.max(1, Math.min(timeoutMs + 5_000, Math.max(1, remaining))),
    );
    const signal = input.signal
      ? AbortSignal.any([input.signal, requestDeadline])
      : requestDeadline;
    let snapshot: ThreadWaitManyResult;
    try {
      requests += 1;
      snapshot = parseSnapshot(
        await input.waitMany(
          {
            timeoutMs,
            targets: targets.map(({ threadId, afterRevision }) => ({
              threadId,
              ...(afterRevision ? { afterRevision } : {}),
            })),
          },
          signal,
        ),
        targets,
      );
      failures = 0;
    } catch (error) {
      if (input.signal?.aborted) return finish("cancelled");
      if (input.timeoutMs > 0 && requestDeadline.aborted && elapsed() >= input.timeoutMs)
        return finish("timeout");
      // Only retry actual transport failures; authentication/protocol/target errors need attention.
      if (
        !(error instanceof DelegationControlError) ||
        error.code !== "RUNTIME_UNREACHABLE" ||
        !error.details?.cause ||
        ++failures > 2
      )
        throw error;
      try {
        await delay(
          Math.min(250 * 2 ** (failures - 1), input.timeoutMs - elapsed()),
          undefined,
          input.signal ? { signal: input.signal } : {},
        );
      } catch {
        return finish("cancelled");
      }
      continue;
    }
    const events: ThreadObserveEvent[] = [];
    for (const row of snapshot.results) {
      const target = byId.get(row.threadId);
      if (!target) throw new DelegationControlError("INTERNAL_ERROR", "Unexpected observed Thread");
      if (row.outcome === "error") {
        events.push({ threadId: row.threadId, reason: "error", error: row.error });
        continue;
      }
      const previous = statuses.get(row.threadId);
      const view = row.status;
      const newRevision = target.afterRevision !== row.revision;
      const expected = target.expectedTurnId ?? previous?.turn?.turnId;
      if (row.outcome === "resync") events.push({ threadId: row.threadId, reason: "resync" });
      else if (expected !== undefined && expected !== view.turn?.turnId)
        events.push({ threadId: row.threadId, reason: "turn-changed" });
      else if ((view.pendingInteractions ?? 0) > 0)
        events.push({ threadId: row.threadId, reason: "needs-input" });
      else if (
        ["completed", "failed", "interrupted"].includes(view.status) &&
        newRevision &&
        (!previous ||
          previous.status !== view.status ||
          previous.turn?.turnId !== view.turn?.turnId)
      )
        events.push({ threadId: row.threadId, reason: "terminal" });
      else if (newRevision && previous) suppressedChanges += 1;
      target.afterRevision = row.revision;
      if (target.expectedTurnId === undefined && view.turn)
        target.expectedTurnId = view.turn.turnId;
      statuses.set(row.threadId, view);
    }
    if (events.length) return finish("attention", events);
  }
}
