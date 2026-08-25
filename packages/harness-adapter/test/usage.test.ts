import { describe, expect, it } from "vitest";

import { parseHostUsage } from "../src/index.js";

describe("Harness Usage", () => {
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
});
