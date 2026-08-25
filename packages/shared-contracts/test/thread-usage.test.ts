import { describe, expect, it } from "vitest";

import {
  threadUsageInspectionSchema,
  threadUsageSnapshotSchema,
} from "@codexhost/shared-contracts";

describe("Thread Usage contracts", () => {
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
