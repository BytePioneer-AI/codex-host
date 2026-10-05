import { describe, expect, it } from "vitest";

import { sessionUsageFromHistory, usageFromCompact, usageFromNative } from "../src/grok-usage.js";

// Numeric fields from a local three-request Grok Turn; no prompts or identities.
const nativeApiUsage = {
  inputTokens: 78636,
  outputTokens: 1571,
  totalTokens: 80207,
  cachedReadTokens: 23680,
  cacheCreationTokens: 0,
  reasoningTokens: 925,
  modelCalls: 3,
  apiDurationMs: 19057,
  costUsdTicks: 992010400,
};

describe("Grok native API average speed", () => {
  it("uses total output / summed API duration, retaining native cost without inventing TPS", () => {
    const usage = usageFromNative(nativeApiUsage);
    expect(usage?.apiOutputTokensPerSecond).toBeCloseTo(82.4369, 4);
    expect(usage?.totalCostUsd).toBe(0.09920104);
    expect(usage?.outputTokens).toBe(1571); // reasoning is already included
    expect(usage).not.toHaveProperty("outputTokensPerSecond");
  });
  it.each([
    { apiDurationMs: 0 },
    { apiDurationMs: -1 },
    { apiDurationMs: NaN },
    { apiDurationMs: Infinity },
    { apiDurationMs: "19057" },
    { apiDurationMs: undefined },
    { modelCalls: 0 },
    { modelCalls: undefined },
    { usageIsIncomplete: true },
    { usageIsIncomplete: "unknown" },
  ])("omits an untrustworthy speed without losing native cost: %j", (patch) => {
    const usage = usageFromNative({ ...nativeApiUsage, ...patch });
    expect(usage).not.toHaveProperty("apiOutputTokensPerSecond");
    expect(usage?.totalCostUsd).toBe(0.09920104);
  });
  it("accepts explicitly zero output but not missing output", () => {
    expect(usageFromNative({ ...nativeApiUsage, outputTokens: 0 })?.apiOutputTokensPerSecond).toBe(
      0,
    );
    expect(usageFromNative({ ...nativeApiUsage, outputTokens: undefined })).not.toHaveProperty(
      "apiOutputTokensPerSecond",
    );
  });
  it("restores the last Turn rate rather than dividing session output by the last duration", () => {
    const events = [
      { type: "turn.completed", nativeTurnKey: "one", usage: nativeApiUsage },
      {
        type: "turn.completed",
        nativeTurnKey: "two",
        usage: { ...nativeApiUsage, outputTokens: 100, apiDurationMs: 2000 },
      },
    ] as const;
    const usage = sessionUsageFromHistory([
      ...events,
      events[1],
      { type: "turn.completed", nativeTurnKey: "two" },
      {
        type: "turn.completed",
        nativeTurnKey: "task-completed-child",
        usage: nativeApiUsage,
      },
    ]);
    expect(usage?.apiOutputTokensPerSecond).toBe(50);
    expect(usage?.outputTokens).toBe(1671);
    expect(usage?.totalCostUsd).toBe(0.19840208);
    expect(
      sessionUsageFromHistory([
        ...events,
        {
          type: "turn.completed",
          nativeTurnKey: "no-timing",
          usage: { outputTokens: 5 },
        },
      ]),
    ).not.toHaveProperty("apiOutputTokensPerSecond");
  });
});

describe("sessionUsageFromHistory", () => {
  it("returns null when no persisted Turn Usage exists", () => {
    expect(sessionUsageFromHistory([])).toBeNull();
    expect(
      sessionUsageFromHistory([{ type: "turn.completed", nativeTurnKey: "grok-prompt-1" }]),
    ).toBeNull();
  });

  it("sums ticks once and keeps the latest cache hit rate", () => {
    expect(
      sessionUsageFromHistory([
        {
          type: "turn.completed",
          nativeTurnKey: "grok-prompt-1",
          usage: {
            inputTokens: 100,
            outputTokens: 10,
            totalTokens: 110,
            cachedReadTokens: 80,
            cacheCreationTokens: 0,
            reasoningTokens: 4,
            costUsdTicks: 126890500,
          },
        },
        {
          type: "turn.completed",
          nativeTurnKey: "task-completed-1",
          usage: { inputTokens: 9, costUsdTicks: 999 },
        },
        {
          type: "turn.completed",
          nativeTurnKey: "grok-prompt-2",
          usage: {
            inputTokens: 50,
            outputTokens: 5,
            totalTokens: 55,
            cachedReadTokens: 45,
            cacheCreationTokens: 2,
            reasoningTokens: 1,
            costUsdTicks: 2388600000,
          },
        },
        {
          type: "turn.completed",
          nativeTurnKey: "grok-prompt-2",
        },
      ]),
    ).toEqual({
      inputTokens: 150,
      outputTokens: 15,
      totalTokens: 165,
      cachedInputTokens: 125,
      cacheWriteInputTokens: 2,
      reasoningOutputTokens: 5,
      totalCostUsd: 0.25154905,
      cacheHitRatePercent: 90,
    });
  });

  it("builds context usage from succeeded compact token counts", () => {
    expect(usageFromCompact(10820, 500000)).toEqual({
      contextUsedTokens: 10820,
      contextWindowTokens: 500000,
    });
    expect(usageFromCompact(undefined, 500000)).toBeNull();
    expect(usageFromCompact(10820, undefined)).toBeNull();
  });

  it("omits cost when no Turn stamped ticks", () => {
    expect(
      sessionUsageFromHistory([
        {
          type: "turn.completed",
          nativeTurnKey: "grok-prompt-1",
          usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
        },
      ]),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
    });
  });
});
