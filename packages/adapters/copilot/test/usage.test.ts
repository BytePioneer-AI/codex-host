import { describe, expect, it } from "vitest";
import { usageFromMetrics } from "../src/usage.js";
type Metrics = Parameters<typeof usageFromMetrics>[0];
describe("Copilot cumulative usage snapshots", () => {
  it("includes native cache tokens in input, replaces totals on repeat/resume, and does not invent currency", () => {
    const metrics = {
      tokenDetails: {
        input: { tokenCount: 9 },
        cache_read: { tokenCount: 25469 },
        cache_write: { tokenCount: 12402 },
        output: { tokenCount: 35 },
      },
      totalNanoAiu: 182334000,
      totalPremiumRequestCost: 3,
    } as Metrics;
    const first = usageFromMetrics(metrics, {
      contextWindowTokens: 272000,
      contextUsedTokens: 13200,
    });
    expect(first).toEqual({
      totalCredits: 0.182334,
      inputTokens: 37880,
      cachedInputTokens: 25469,
      cacheWriteInputTokens: 12402,
      outputTokens: 35,
      contextWindowTokens: 272000,
      contextUsedTokens: 13200,
      sessionCacheUsage: { inputTokens: 37880, cachedInputTokens: 25469 },
    });
    expect(usageFromMetrics(metrics, first)).toEqual(first);
    expect(usageFromMetrics(metrics, null)?.inputTokens).toBe(37880);
  });
  it("keeps unknown totals absent", () => {
    expect(usageFromMetrics({} as Metrics, null)).toBeNull();
    expect(
      usageFromMetrics({ tokenDetails: { input: { tokenCount: 5 } } } as Metrics, null),
    ).toBeNull();
  });
  it("does not turn unavailable, partial, missing or invalid AI credit totals into zero", () => {
    for (const aiCreditsStatus of ["partial", "unavailable"] as const)
      expect(usageFromMetrics({ totalNanoAiu: 1000000000, aiCreditsStatus }, null)).toBeNull();
    for (const totalNanoAiu of [0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      expect(usageFromMetrics({ totalNanoAiu }, null)).toBeNull();
    expect(usageFromMetrics({ totalNanoAiu: 0, aiCreditsStatus: "complete" }, null)).toEqual({
      totalCredits: 0,
    });
    expect(
      usageFromMetrics({ totalNanoAiu: 2500000000, aiCreditsStatus: "complete" }, null),
    ).toEqual({ totalCredits: 2.5 });
  });
});
