import { z } from "zod";
import {
  accountBalanceSnapshotSchema,
  accountCreditsPeriodSchema,
  type AccountBalanceSnapshot,
  type AccountCreditsSnapshot,
} from "./thread-usage.js";
import { harnessAccountSnapshotSchema } from "./harness-accounts.js";

export const DEFAULT_QUOTA_CONTINUATION_PROMPT =
  "[codexhost quota continuation] Quota has refreshed. Review your current progress and continue the unfinished task from where you stopped.";

const usagePercentSchema = z.number().finite().min(0).max(100);

export const quotaWindowSnapshotSchema = z
  .object({
    periodType: accountCreditsPeriodSchema,
    usedPercent: usagePercentSchema,
    resetsAt: z.string().min(1).optional(),
    scopeId: z.string().min(1).max(256).optional(),
    scopeLabel: z.string().min(1).max(256).optional(),
    label: z.string().min(1).max(256).optional(),
    isPrimary: z.boolean(),
  })
  .strict();
export type QuotaWindowSnapshot = z.infer<typeof quotaWindowSnapshotSchema>;

export const quotaAvailabilityStatusSchema = z.enum([
  "available",
  "exhausted",
  "prepaidOnly",
  "unknown",
]);
export type QuotaAvailabilityStatus = z.infer<typeof quotaAvailabilityStatusSchema>;

export const quotaAvailabilityEvaluationSchema = z
  .object({
    status: quotaAvailabilityStatusSchema,
    windows: z.array(quotaWindowSnapshotSchema),
    blockingWindows: z.array(quotaWindowSnapshotSchema),
    blockingPeriods: z.array(accountCreditsPeriodSchema),
    minRemainingPercent: usagePercentSchema.optional(),
    /** Latest reset timestamp across known blocking windows; only unblockable once every blocking window clears. */
    earliestUnblockAt: z.string().min(1).optional(),
    allBlockingResetsKnown: z.boolean(),
  })
  .strict();
export type QuotaAvailabilityEvaluation = z.infer<typeof quotaAvailabilityEvaluationSchema>;

export const harnessQuotaAlternativeSchema = z
  .object({
    harnessId: z.string().trim().min(1).max(128),
    harnessName: z.string().trim().min(1).max(128),
    poolKey: z.string().trim().min(1).max(320),
    minRemainingPercent: usagePercentSchema,
    plan: z.string().trim().min(1).max(128).optional(),
  })
  .strict();
export type HarnessQuotaAlternative = z.infer<typeof harnessQuotaAlternativeSchema>;

export const harnessQuotaSummarySchema = z
  .object({
    harnessId: z.string().trim().min(1).max(128),
    harnessName: z.string().trim().min(1).max(128),
    poolKey: z.string().trim().min(1).max(320),
    status: quotaAvailabilityStatusSchema,
    windows: z.array(quotaWindowSnapshotSchema),
    blockingWindows: z.array(quotaWindowSnapshotSchema),
    blockingPeriods: z.array(accountCreditsPeriodSchema),
    minRemainingPercent: usagePercentSchema.optional(),
    earliestUnblockAt: z.string().min(1).optional(),
    allBlockingResetsKnown: z.boolean(),
    /** True when native Codex reports available reset cards; codexhost never auto-consumes them. */
    hasResetCredits: z.boolean().optional(),
    balance: accountBalanceSnapshotSchema.optional(),
    accounts: z.array(harnessAccountSnapshotSchema).max(8).optional(),
  })
  .strict();
export type HarnessQuotaSummary = z.infer<typeof harnessQuotaSummarySchema>;

export const harnessQuotaListResultSchema = z
  .object({
    observedAt: z.string().min(1),
    harnesses: z.array(harnessQuotaSummarySchema),
    availableAlternatives: z.array(harnessQuotaAlternativeSchema),
  })
  .strict();
export type HarnessQuotaListResult = z.infer<typeof harnessQuotaListResultSchema>;

export const quotaContinuationStateSchema = z.enum([
  "waitingForReset",
  "verifying",
  "readyToResume",
  "resumed",
  "cancelled",
  "expired",
  "failed",
]);
export type QuotaContinuationState = z.infer<typeof quotaContinuationStateSchema>;

function normalizeIdentifier(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
}

function remainingPercentOf(usedPercent: number): number {
  return Math.max(0, Math.round((100 - usedPercent) * 100) / 100);
}

/** Flattens the primary window and `productUsage` entries from an `AccountCreditsSnapshot`. */
export function extractQuotaWindows(credits: AccountCreditsSnapshot): QuotaWindowSnapshot[] {
  const primary: QuotaWindowSnapshot = {
    periodType: credits.periodType,
    usedPercent: credits.usedPercent,
    ...(credits.resetsAt ? { resetsAt: credits.resetsAt } : {}),
    ...(credits.scope ? { scopeId: credits.scope.id, scopeLabel: credits.scope.label } : {}),
    ...(credits.label ? { label: credits.label } : {}),
    isPrimary: true,
  };
  const others: QuotaWindowSnapshot[] = (credits.productUsage ?? []).map((item) => ({
    periodType: item.periodType ?? "unknown",
    usedPercent: item.usagePercent,
    ...(item.resetsAt ? { resetsAt: item.resetsAt } : {}),
    ...(item.scope ? { scopeId: item.scope.id, scopeLabel: item.scope.label } : {}),
    label: item.product,
    isPrimary: false,
  }));
  return [primary, ...others];
}

/**
 * Selects the quota windows that govern a Thread:
 * - Unscoped (account-wide) windows always apply.
 * - Scoped windows whose scope matches `harnessId` (e.g. Kimi Code's `kimi-code` 5h window) apply
 *   to the whole Harness.
 * - Model/product-scoped windows apply only when matching `scopeId`, or matching the primary
 *   window's scope when `scopeId` is omitted (e.g. Antigravity Session-projected model groups).
 */
export function filterApplicableQuotaWindows(
  windows: readonly QuotaWindowSnapshot[],
  options: { harnessId?: string; scopeId?: string } = {},
): QuotaWindowSnapshot[] {
  const normalizedHarness = normalizeIdentifier(options.harnessId);
  const explicitScope = normalizeIdentifier(options.scopeId);
  const primary = windows.find((window) => window.isPrimary);
  const primaryScope = normalizeIdentifier(primary?.scopeId);
  const effectiveScope =
    explicitScope ??
    (primaryScope && primaryScope !== normalizedHarness ? primaryScope : undefined);

  return windows.filter((window) => {
    const windowScope = normalizeIdentifier(window.scopeId);
    if (!windowScope) return true;
    if (normalizedHarness && windowScope === normalizedHarness) return true;
    return effectiveScope !== undefined && windowScope === effectiveScope;
  });
}

/**
 * Evaluates whether applicable quota windows currently block execution and computes the latest
 * reset timestamp across all blocking windows (`MAX(resetsAt)`), so a 5h reset does not falsely
 * unblock a Thread while a 7-day / weekly window remains exhausted.
 */
export function evaluateQuotaAvailability(input: {
  credits?: AccountCreditsSnapshot | null;
  balance?: AccountBalanceSnapshot | null;
  harnessId?: string;
  scopeId?: string;
  minHeadroomPercent?: number;
}): QuotaAvailabilityEvaluation {
  const minHeadroom =
    typeof input.minHeadroomPercent === "number" && Number.isFinite(input.minHeadroomPercent)
      ? Math.min(100, Math.max(0, input.minHeadroomPercent))
      : 0;

  if (!input.credits) {
    return {
      status: input.balance ? "prepaidOnly" : "unknown",
      windows: [],
      blockingWindows: [],
      blockingPeriods: [],
      allBlockingResetsKnown: false,
    };
  }

  const allWindows = extractQuotaWindows(input.credits);
  const applicable = filterApplicableQuotaWindows(allWindows, {
    ...(input.harnessId ? { harnessId: input.harnessId } : {}),
    ...(input.scopeId ? { scopeId: input.scopeId } : {}),
  });

  if (applicable.length === 0) {
    return {
      status: "unknown",
      windows: [],
      blockingWindows: [],
      blockingPeriods: [],
      allBlockingResetsKnown: false,
    };
  }

  let minRemaining = 100;
  const blockingWindows: QuotaWindowSnapshot[] = [];
  for (const window of applicable) {
    const remaining = remainingPercentOf(window.usedPercent);
    if (remaining < minRemaining) minRemaining = remaining;
    if (window.usedPercent >= 100 || (minHeadroom > 0 && remaining < minHeadroom)) {
      blockingWindows.push(window);
    }
  }

  if (blockingWindows.length === 0) {
    return {
      status: "available",
      windows: applicable,
      blockingWindows: [],
      blockingPeriods: [],
      minRemainingPercent: minRemaining,
      allBlockingResetsKnown: true,
    };
  }

  let latestResetMs: number | undefined;
  let allBlockingResetsKnown = true;
  for (const window of blockingWindows) {
    const parsed = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
    if (!Number.isFinite(parsed)) {
      allBlockingResetsKnown = false;
      continue;
    }
    if (latestResetMs === undefined || parsed > latestResetMs) latestResetMs = parsed;
  }

  return {
    status: "exhausted",
    windows: applicable,
    blockingWindows,
    blockingPeriods: [...new Set(blockingWindows.map((window) => window.periodType))],
    minRemainingPercent: minRemaining,
    ...(latestResetMs !== undefined
      ? { earliestUnblockAt: new Date(latestResetMs).toISOString() }
      : {}),
    allBlockingResetsKnown,
  };
}

/**
 * Derives a coordination pool key used to serialize wakeups and share quota probes across Threads.
 * Explicit `poolKey` lets callers link Harnesses sharing one upstream Billing Source (for example
 * Codex and an imported Pi provider) without guessing from emails across unrelated Providers.
 */
export function deriveQuotaPoolKey(input: {
  harnessId: string;
  scopeId?: string;
  poolKey?: string;
}): string {
  const explicit = normalizeIdentifier(input.poolKey);
  if (explicit) return `pool:${explicit}`;
  const harness = normalizeIdentifier(input.harnessId) ?? "unknown";
  const scope = normalizeIdentifier(input.scopeId) ?? "*";
  return `${harness}:${scope}`;
}

/** Ranks other Harnesses with confirmed available quota, excluding the same Harness or pool. */
export function rankAlternativeHarnesses(
  summaries: readonly HarnessQuotaSummary[],
  exclude: { harnessId?: string; poolKey?: string } = {},
): HarnessQuotaAlternative[] {
  const excludeHarness = normalizeIdentifier(exclude.harnessId);
  const excludePool = normalizeIdentifier(exclude.poolKey);
  return summaries
    .filter((summary) => {
      if (summary.status !== "available" || summary.minRemainingPercent === undefined) return false;
      if (excludeHarness && normalizeIdentifier(summary.harnessId) === excludeHarness) return false;
      if (excludePool && normalizeIdentifier(summary.poolKey) === excludePool) return false;
      return true;
    })
    .sort(
      (left, right) =>
        (right.minRemainingPercent ?? 0) - (left.minRemainingPercent ?? 0) ||
        left.harnessId.localeCompare(right.harnessId),
    )
    .map((summary) => {
      const plan = summary.accounts?.find((account) => account.plan)?.plan;
      return {
        harnessId: summary.harnessId,
        harnessName: summary.harnessName,
        poolKey: summary.poolKey,
        minRemainingPercent: summary.minRemainingPercent ?? 0,
        ...(plan ? { plan } : {}),
      };
    });
}
