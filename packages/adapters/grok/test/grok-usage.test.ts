import { describe, expect, it } from "vitest";

import { sessionUsageFromHistory } from "../src/grok-usage.js";

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
