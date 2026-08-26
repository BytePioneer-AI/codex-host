import { describe, expect, it } from "vitest";

import { observeCodexRateLimits, observeCodexTokenUsage } from "../src/codex-native-usage.js";

describe("Codex native Usage observations", () => {
  it("maps thread token usage into the Host Usage shape", () => {
    expect(
      observeCodexTokenUsage({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "native-thread",
          turnId: "native-turn",
          tokenUsage: {
            total: {
              totalTokens: 1_000,
              inputTokens: 800,
              cachedInputTokens: 600,
              cacheWriteInputTokens: 10,
              outputTokens: 200,
              reasoningOutputTokens: 50,
            },
            last: {
              totalTokens: 240,
              inputTokens: 200,
              cachedInputTokens: 150,
              cacheWriteInputTokens: 5,
              outputTokens: 40,
              reasoningOutputTokens: 10,
            },
            modelContextWindow: 2_000,
          },
        },
      }),
    ).toEqual({
      threadId: "native-thread",
      turnId: "native-turn",
      usage: {
        totalTokens: 1_000,
        inputTokens: 800,
        cachedInputTokens: 600,
        cacheWriteInputTokens: 10,
        outputTokens: 200,
        reasoningOutputTokens: 50,
        contextUsedTokens: 240,
        contextWindowTokens: 2_000,
        cacheHitRatePercent: 75,
      },
    });
  });

  it("maps account rate-limit windows to the existing five-hour and seven-day fields", () => {
    expect(
      observeCodexRateLimits({
        id: "internal",
        result: {
          rateLimits: {
            primary: { usedPercent: 2, windowDurationMins: 300, resetsAt: 1_800 },
            secondary: { usedPercent: 8, windowDurationMins: 10_080, resetsAt: 2_400 },
          },
          rateLimitsByLimitId: null,
        },
      }),
    ).toEqual({
      planFiveHourUsedPercent: 2,
      planFiveHourResetsAtUnix: 1_800,
      planSevenDayUsedPercent: 8,
      planSevenDayResetsAtUnix: 2_400,
    });
  });

  it("ignores model-specific buckets and keeps only the generic account limit", () => {
    expect(
      observeCodexRateLimits({
        id: "internal",
        result: {
          rateLimits: {
            primary: { usedPercent: 11, windowDurationMins: 10_080, resetsAt: 3_000 },
            secondary: null,
          },
          rateLimitsByLimitId: {
            codex_model: {
              primary: { usedPercent: 4, windowDurationMins: 300, resetsAt: 4_000 },
              secondary: { usedPercent: 12, windowDurationMins: 10_080, resetsAt: 5_000 },
            },
          },
        },
      }),
    ).toEqual({
      planSevenDayUsedPercent: 11,
      planSevenDayResetsAtUnix: 3_000,
    });
  });

  it("ignores model-specific rolling notifications", () => {
    expect(
      observeCodexRateLimits({
        method: "account/rateLimits/updated",
        params: {
          rateLimits: {
            limitId: "codex_spark",
            primary: { usedPercent: 4, windowDurationMins: 300, resetsAt: 4_000 },
            secondary: { usedPercent: 12, windowDurationMins: 10_080, resetsAt: 5_000 },
          },
        },
      }),
    ).toBeNull();
  });

  it("accepts a generic rolling notification with only a weekly window", () => {
    expect(
      observeCodexRateLimits({
        method: "account/rateLimits/updated",
        params: {
          rateLimits: {
            limitId: "codex",
            primary: null,
            secondary: { usedPercent: 12, windowDurationMins: 10_080, resetsAt: 5_000 },
          },
        },
      }),
    ).toEqual({
      planSevenDayUsedPercent: 12,
      planSevenDayResetsAtUnix: 5_000,
    });
  });
});
