import { parseHostUsage, type HostUsage } from "@codexhost/harness-adapter";
import { hostThreadIdSchema, hostTurnIdSchema, type HostTurnId } from "@codexhost/shared-contracts";

interface CodexTokenUsageObservation {
  threadId: string;
  turnId: HostTurnId;
  usage: HostUsage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function finitePercent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : undefined;
}

function optionalReset(value: unknown): number | undefined {
  return nonNegativeSafeInteger(value);
}

function addBreakdown(
  target: Partial<HostUsage>,
  source: Record<string, unknown> | undefined,
): void {
  if (!source) return;
  const fields = [
    ["totalTokens", "totalTokens"],
    ["inputTokens", "inputTokens"],
    ["cachedInputTokens", "cachedInputTokens"],
    ["cacheWriteInputTokens", "cacheWriteInputTokens"],
    ["outputTokens", "outputTokens"],
    ["reasoningOutputTokens", "reasoningOutputTokens"],
  ] as const;
  for (const [sourceField, targetField] of fields) {
    const value = nonNegativeSafeInteger(source[sourceField]);
    if (value !== undefined) target[targetField] = value;
  }
}

export function observeCodexTokenUsage(value: unknown): CodexTokenUsageObservation | null {
  if (!isRecord(value) || value.method !== "thread/tokenUsage/updated") return null;
  const params = value.params;
  if (!isRecord(params)) return null;
  const threadId = hostThreadIdSchema.safeParse(params.threadId);
  const turnId = hostTurnIdSchema.safeParse(params.turnId);
  if (!threadId.success || !turnId.success) return null;
  const tokenUsage = params.tokenUsage;
  if (!isRecord(tokenUsage)) return null;

  const total = isRecord(tokenUsage.total) ? tokenUsage.total : undefined;
  const last = isRecord(tokenUsage.last) ? tokenUsage.last : undefined;
  const usage: Partial<HostUsage> = {};
  addBreakdown(usage, total);

  const contextUsedTokens = nonNegativeSafeInteger(last?.totalTokens);
  const contextWindowTokens = nonNegativeSafeInteger(tokenUsage.modelContextWindow);
  if (
    contextUsedTokens !== undefined &&
    contextWindowTokens !== undefined &&
    contextWindowTokens > 0
  ) {
    usage.contextUsedTokens = contextUsedTokens;
    usage.contextWindowTokens = contextWindowTokens;
  }

  const inputTokens = nonNegativeSafeInteger(last?.inputTokens);
  const cachedInputTokens = nonNegativeSafeInteger(last?.cachedInputTokens);
  if (inputTokens !== undefined && cachedInputTokens !== undefined && inputTokens > 0) {
    usage.cacheHitRatePercent = Math.min(100, (cachedInputTokens / inputTokens) * 100);
  }

  try {
    return {
      threadId: threadId.data,
      turnId: turnId.data,
      usage: parseHostUsage(usage),
    };
  } catch {
    return null;
  }
}

interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number;
  resetsAt?: number;
}

interface RateLimitCandidate {
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
}

function parseRateLimitWindow(value: unknown): RateLimitWindow | null {
  if (!isRecord(value)) return null;
  const usedPercent = finitePercent(value.usedPercent);
  const windowDurationMins = nonNegativeSafeInteger(value.windowDurationMins);
  if (usedPercent === undefined || windowDurationMins === undefined || windowDurationMins === 0) {
    return null;
  }
  const resetsAt = optionalReset(value.resetsAt);
  return { usedPercent, windowDurationMins, ...(resetsAt !== undefined ? { resetsAt } : {}) };
}

function parseRateLimitCandidate(
  value: unknown,
  options: { genericOnly?: boolean } = {},
): RateLimitCandidate | null {
  if (!isRecord(value)) return null;
  if (
    options.genericOnly &&
    value.limitId !== undefined &&
    value.limitId !== null &&
    value.limitId !== "codex"
  ) {
    // Rolling notifications can carry a model-specific snapshot (for
    // example, GPT-5.3-Codex-Spark). It must not replace the account-wide
    // `codex` bucket in the Usage popover.
    return null;
  }
  const primary = parseRateLimitWindow(value.primary);
  const secondary = parseRateLimitWindow(value.secondary);
  return primary || secondary ? { primary, secondary } : null;
}

function rateLimitCandidates(value: unknown): RateLimitCandidate[] {
  if (!isRecord(value)) return [];
  const result = isRecord(value.result) ? value.result : value;
  if (!isRecord(result)) return [];
  const candidates: RateLimitCandidate[] = [];
  const base = parseRateLimitCandidate(result.rateLimits, { genericOnly: true });
  if (base) candidates.push(base);
  // `rateLimitsByLimitId` contains model-specific buckets (for example,
  // GPT-5.3-Codex-Spark). Usage reports the account-level limit, so these
  // buckets must not replace or augment the generic account snapshot.
  const notificationParams = isRecord(value.params) ? value.params : undefined;
  const notificationSnapshot = parseRateLimitCandidate(notificationParams?.rateLimits, {
    genericOnly: true,
  });
  if (notificationSnapshot) candidates.push(notificationSnapshot);
  return candidates;
}

function candidateScore(candidate: RateLimitCandidate): number {
  return [candidate.primary, candidate.secondary].filter(
    (window) => window?.windowDurationMins === 300 || window?.windowDurationMins === 10_080,
  ).length;
}

function applyWindow(target: Partial<HostUsage>, window: RateLimitWindow | null): void {
  if (!window) return;
  const prefix =
    window.windowDurationMins === 300
      ? "planFiveHour"
      : window.windowDurationMins === 10_080
        ? "planSevenDay"
        : null;
  if (!prefix) return;
  target[`${prefix}UsedPercent` as "planFiveHourUsedPercent" | "planSevenDayUsedPercent"] =
    window.usedPercent;
  if (window.resetsAt !== undefined) {
    target[`${prefix}ResetsAtUnix` as "planFiveHourResetsAtUnix" | "planSevenDayResetsAtUnix"] =
      window.resetsAt;
  }
}

export function observeCodexRateLimits(value: unknown): Partial<HostUsage> | null {
  const candidate = rateLimitCandidates(value).sort(
    (left, right) => candidateScore(right) - candidateScore(left),
  )[0];
  if (!candidate) return null;
  const usage: Partial<HostUsage> = {};
  applyWindow(usage, candidate.primary);
  applyWindow(usage, candidate.secondary);
  try {
    return Object.keys(usage).length > 0 ? parseHostUsage(usage) : null;
  } catch {
    return null;
  }
}
