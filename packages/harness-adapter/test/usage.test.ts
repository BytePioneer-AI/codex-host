import { describe, expect, it } from "vitest";

import { parseHostUsage, parseHostUsageRequest } from "../src/index.js";

describe("Harness Usage", () => {
  it("accepts fractional native token rates without relaxing token counts", () => {
    expect(parseHostUsage({ outputTokensPerSecond: 42.7 })).toEqual({
      outputTokensPerSecond: 42.7,
    });
    expect(parseHostUsage({ outputTokensPerSecond: 0 })).toEqual({ outputTokensPerSecond: 0 });
    for (const rate of [-1, NaN, Infinity, "42.7"]) {
      expect(() => parseHostUsage({ outputTokensPerSecond: rate })).toThrow();
    }
    expect(() => parseHostUsage({ outputTokens: 42.7 })).toThrow();
  });
  it("accepts native credits and independent context percent without fake tokens", () => {
    expect(parseHostUsage({ totalCredits: 0.125, contextUsagePercent: 102 })).toEqual({
      totalCredits: 0.125,
      contextUsagePercent: 102,
    });
    for (const value of [-1, Infinity, NaN]) {
      expect(() => parseHostUsage({ totalCredits: value })).toThrow();
      expect(() => parseHostUsage({ contextUsagePercent: value })).toThrow();
    }
  });
  it("accepts reliable native aggregate and context fields", () => {
    const input = {
      inputTokens: 10,
      cachedInputTokens: 2,
      cacheWriteInputTokens: 1,
      outputTokens: 5,
      reasoningOutputTokens: 3,
      totalTokens: 21,
      totalCostUsd: 0.125,
      cacheHitRatePercent: 99.9,
      contextUsedTokens: 120,
      contextWindowTokens: 100,
    };

    expect(parseHostUsage(input)).toEqual(input);
  });

  it.each([
    null,
    {},
    { totalTokens: -1 },
    { totalTokens: 1.5 },
    { totalTokens: Number.MAX_SAFE_INTEGER + 1 },
    { totalCostUsd: Number.POSITIVE_INFINITY },
    { totalCostUsd: -0.1 },
    { cacheHitRatePercent: -0.1 },
    { cacheHitRatePercent: 100.1 },
    { cacheHitRatePercent: Number.NaN },
    { contextUsedTokens: 10 },
    { contextWindowTokens: 100 },
    { contextUsedTokens: 0, contextWindowTokens: 0 },
    { totalTokens: 10, nativePayload: {} },
  ])("rejects invalid snapshots %#", (input) => {
    expect(() => parseHostUsage(input)).toThrow();
  });

  it("accepts optional Claude.ai plan windows alongside cache hit rate and cost", () => {
    const input = {
      cacheHitRatePercent: 99,
      totalCostUsd: 1.373,
      planFiveHourUsedPercent: 45,
      planFiveHourResetsAtUnix: 1_756_130_400,
      planSevenDayUsedPercent: 12.5,
    };
    expect(parseHostUsage(input)).toEqual(input);
  });

  it("accepts a plan used percent with no reset", () => {
    expect(parseHostUsage({ planFiveHourUsedPercent: 45 })).toEqual({
      planFiveHourUsedPercent: 45,
    });
  });

  it.each([
    { planFiveHourResetsAtUnix: 1_756_130_400 },
    { planSevenDayResetsAtUnix: 1_756_130_400 },
    { planFiveHourUsedPercent: -0.1 },
    { planFiveHourUsedPercent: 100.1 },
    { planSevenDayUsedPercent: Number.NaN },
    { planFiveHourResetsAtUnix: -1, planFiveHourUsedPercent: 45 },
    { planFiveHourResetsAtUnix: 1.5, planFiveHourUsedPercent: 45 },
  ])("rejects invalid plan-window snapshots %#", (input) => {
    expect(() => parseHostUsage(input)).toThrow();
  });

  it("accepts Host-derived fields and ties costSource to a cost", () => {
    const usage = {
      totalCostUsd: 0.5,
      costSource: "publicPrice",
      sessionCacheHitRatePercent: 80,
      timeToFirstOutputMs: 1200,
    };
    expect(parseHostUsage(usage)).toEqual(usage);
    expect(() => parseHostUsage({ costSource: "native" })).toThrow();
    expect(() => parseHostUsage({ totalCostUsd: 1, costSource: "guess" })).toThrow();
    expect(() => parseHostUsage({ sessionCacheHitRatePercent: 101 })).toThrow();
    expect(() => parseHostUsage({ timeToFirstOutputMs: 1.5 })).toThrow();
  });
});

describe("Harness Usage request", () => {
  const base = { requestId: "msg-1", inputTokens: 100, outputTokens: 20 };

  it("accepts a unified-convention request with explicit zero cache", () => {
    const request = {
      ...base,
      historical: true,
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: 5,
      outputStartedAtMs: 1_000,
      completedAtMs: 2_000,
    };
    expect(parseHostUsageRequest(request)).toEqual(request);
    expect(parseHostUsageRequest(base)).toEqual(base);
  });

  it.each([
    { ...base, requestId: "" },
    { ...base, inputTokens: undefined },
    { ...base, outputTokens: -1 },
    { ...base, cachedInputTokens: 80, cacheWriteInputTokens: 30 },
    { ...base, reasoningOutputTokens: 21 },
    { ...base, outputStartedAtMs: 1 },
    { ...base, outputStartedAtMs: 2, completedAtMs: 1 },
    { ...base, model: "" },
    { ...base, historical: "yes" },
    { ...base, turnId: "turn-1" },
  ])("rejects invalid requests: %#", (request) => {
    expect(() => parseHostUsageRequest(request)).toThrow();
  });
});
