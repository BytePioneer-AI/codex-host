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
});
