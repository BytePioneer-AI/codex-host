/**
 * Session-cumulative Thread Usage for agy.
 *
 * agy reports Usage per Turn while the Host replaces `thread.latestUsage`
 * wholesale, so the Adapter accumulates Turn Usage itself: token counters sum
 * across Turns and gauges (context fill, window) come from the latest Turn
 * that reported them — the same shape grok derives in `sessionUsageFromHistory`.
 */

import type { HostUsage } from "@codexhost/harness-adapter";

/** Token counters agy reports per Turn; every other field is a latest-wins gauge. */
const SUMMED_USAGE_FIELDS = [
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "totalTokens",
] as const satisfies ReadonlyArray<keyof HostUsage>;

/** Adds one Turn's Usage to the cumulative total of the Turns before it. */
export function addAntigravityTurnUsage(
  base: HostUsage | null,
  next: HostUsage | null,
): HostUsage | null {
  if (!next) return base;
  if (!base) return { ...next };
  const merged: HostUsage = { ...base, ...next };
  for (const field of SUMMED_USAGE_FIELDS) {
    const previous = base[field];
    const current = next[field];
    if (previous !== undefined || current !== undefined) {
      merged[field] = (previous ?? 0) + (current ?? 0);
    }
  }
  return merged;
}

/**
 * agy counts prompt-cache reads (`cache_read_tokens`) separately from
 * `input_tokens` and never reports cache writes, so the rate is
 * read/(input+read); a write count would join the denominator if the wire
 * ever exposes one. Both counters must be present: a missing field is omitted
 * rather than substituted with 0, and a measured zero stays a measured zero.
 */
export function antigravityCacheHitRatePercent(usage: HostUsage): number | undefined {
  const read = usage.cachedInputTokens;
  const input = usage.inputTokens;
  if (read === undefined || input === undefined) return undefined;
  const denominator = input + read + (usage.cacheWriteInputTokens ?? 0);
  return denominator > 0 ? (read / denominator) * 100 : undefined;
}

/** Derives the cache hit rate from cumulative counters, never inventing one. */
export function withAntigravityCacheHitRate(usage: HostUsage | null): HostUsage | null {
  if (!usage) return null;
  const cacheHitRatePercent = antigravityCacheHitRatePercent(usage);
  return cacheHitRatePercent === undefined ? usage : { ...usage, cacheHitRatePercent };
}
