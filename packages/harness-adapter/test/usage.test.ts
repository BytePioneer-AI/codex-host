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
    { contextUsedTokens: 10 },
    { contextWindowTokens: 100 },
    { contextUsedTokens: 0, contextWindowTokens: 0 },
    { totalTokens: 10, nativePayload: {} },
  ])("rejects invalid snapshots %#", (input) => {
    expect(() => parseHostUsage(input)).toThrow();
  });
});
