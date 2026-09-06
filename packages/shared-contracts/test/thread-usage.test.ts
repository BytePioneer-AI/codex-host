import { describe, expect, it } from "vitest";

import {
  threadUsageInspectionParamsSchema,
  threadUsageInspectionSchema,
  threadUsageSnapshotSchema,
} from "@codexhost/shared-contracts";

describe("Thread Usage contracts", () => {
  it("carries credits and independent context percent through usage inspection", () => {
    const usage = { totalCredits: 0.125, contextUsagePercent: 102 };
    expect(threadUsageInspectionSchema.parse({ threadId: "kiro", usage }).usage).toEqual(usage);
    for (const value of [-1, Infinity, NaN]) {
      expect(threadUsageSnapshotSchema.safeParse({ totalCredits: value }).success).toBe(false);
      expect(threadUsageSnapshotSchema.safeParse({ contextUsagePercent: value }).success).toBe(
        false,
      );
    }
  });
  it("accepts reliable cache and cost fields", () => {
    const usage = {
      cachedInputTokens: 32_000,
      cacheWriteInputTokens: 1_200,
      cacheHitRatePercent: 99.9,
      totalCostUsd: 0.168,
      contextUsedTokens: 31_200,
      contextWindowTokens: 128_000,
    };
    expect(threadUsageSnapshotSchema.parse(usage)).toEqual(usage);
    expect(threadUsageInspectionSchema.parse({ threadId: "thread-usage", usage })).toEqual({
      threadId: "thread-usage",
      usage,
    });
    expect(
      threadUsageInspectionSchema.parse({
        threadId: "thread-usage",
        usage,
        accountCredits: {
          usedPercent: 33,
          resetsAt: "2026-08-20T03:32:07.498525+00:00",
          periodType: "weekly",
        },
      }),
    ).toMatchObject({
      accountCredits: { usedPercent: 33, periodType: "weekly" },
    });
  });

  it.each([
    { cacheHitRatePercent: 100.1 },
    { totalCostUsd: -0.1 },
    { contextUsedTokens: 10 },
    { contextWindowTokens: 100 },
    {},
  ])("rejects invalid or incomplete snapshots: %#", (usage) => {
    expect(threadUsageSnapshotSchema.safeParse(usage).success).toBe(false);
  });

  it("rejects undeclared fields", () => {
    expect(
      threadUsageSnapshotSchema.safeParse({ totalCostUsd: 0.1, nativeCost: 0.2 }).success,
    ).toBe(false);
  });

  it("accepts only the fixed exact refresh mode", () => {
    expect(
      threadUsageInspectionParamsSchema.parse({ threadId: "thread-usage", refresh: "exact" }),
    ).toEqual({ threadId: "thread-usage", refresh: "exact" });
    expect(
      threadUsageInspectionParamsSchema.safeParse({ threadId: "thread-usage", refresh: "newer" })
        .success,
    ).toBe(false);
  });

  it("accepts optional Claude.ai plan windows and passes them through inspection", () => {
    const usage = {
      cacheHitRatePercent: 99,
      totalCostUsd: 1.373,
      planFiveHourUsedPercent: 45,
      planFiveHourResetsAtUnix: 1_756_130_400,
    };
    expect(threadUsageSnapshotSchema.parse(usage)).toEqual(usage);
    expect(threadUsageInspectionSchema.parse({ threadId: "thread-usage", usage })).toEqual({
      threadId: "thread-usage",
      usage,
    });
  });

  it("accepts a seven-day window without a five-hour window", () => {
    const usage = { planSevenDayUsedPercent: 12.5 };
    expect(threadUsageSnapshotSchema.parse(usage)).toEqual(usage);
  });

  it.each([
    { planFiveHourResetsAtUnix: 1_756_130_400 },
    { planSevenDayResetsAtUnix: 1_756_130_400 },
    { planFiveHourUsedPercent: 100.1 },
    { planFiveHourResetsAtUnix: -1, planFiveHourUsedPercent: 45 },
  ])("rejects invalid plan-window snapshots: %#", (usage) => {
    expect(threadUsageSnapshotSchema.safeParse(usage).success).toBe(false);
  });
});
