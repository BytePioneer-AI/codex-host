import type { ThreadUsageInspection, ThreadUsageSnapshot } from "@codexhost/shared-contracts";

import type { SessionLog } from "./session-log.js";

type InputUsage = Pick<
  ThreadUsageSnapshot,
  "inputTokens" | "cachedInputTokens" | "cacheWriteInputTokens" | "outputTokens" | "totalTokens"
>;

/** Unknown cache buckets cannot establish uncached input or a cumulative cache ratio. */
export function projectUncachedInputTokens(usage: InputUsage | null): number | null {
  if (usage?.cachedInputTokens === undefined || usage.cacheWriteInputTokens === undefined)
    return null;
  const cached = usage.cachedInputTokens + usage.cacheWriteInputTokens;
  if (usage.totalTokens !== undefined && usage.outputTokens !== undefined) {
    // Also supports older CH Pi snapshots whose inputTokens excluded cache, without guessing
    // the convention from the relative sizes of the input and cache buckets.
    const fromTotal = usage.totalTokens - usage.outputTokens - cached;
    return fromTotal >= 0 ? fromTotal : null;
  }

  if (usage.inputTokens === undefined || usage.inputTokens < cached) return null;
  return usage.inputTokens - cached;
}

/** DSH's generic meter requires four known disjoint buckets; empty hides that meter. */
export function projectTokenUsage(usage: InputUsage | null) {
  const uncached = projectUncachedInputTokens(usage);
  if (
    uncached === null ||
    usage?.outputTokens === undefined ||
    usage.cachedInputTokens === undefined ||
    usage.cacheWriteInputTokens === undefined
  ) {
    return { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  }
  return {
    uncachedInputTokens: uncached,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cachedInputTokens,
    cacheWriteTokens: usage.cacheWriteInputTokens,
  };
}

/** Project one validated Host snapshot into the generic DSH meters and CH detail surface. */
export function applyUsageProjections(log: SessionLog, value: ThreadUsageInspection): void {
  const { usage, accountCredits } = value;
  log.setProjection(
    "codexhostUsage",
    usage !== null || accountCredits !== undefined
      ? { usage, ...(accountCredits === undefined ? {} : { accountCredits }) }
      : null,
  );

  // Keep the authoritative Host cache rates above even when its cumulative token split is
  // unavailable (e.g. Claude Code). Missing counts must not become a fabricated 0% below.
  log.setProjection("tokenUsage", projectTokenUsage(usage));

  log.setProjection(
    "contextPressure",
    usage?.contextUsedTokens !== undefined && usage.contextWindowTokens !== undefined
      ? {
          pressureTokens: usage.contextUsedTokens,
          projectedTokens: usage.contextUsedTokens,
          contextWindow: usage.contextWindowTokens,
        }
      : {},
  );
}
