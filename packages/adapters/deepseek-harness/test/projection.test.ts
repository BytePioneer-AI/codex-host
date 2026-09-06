import { describe, expect, it } from "vitest";

import { parseDeepSeekUsage } from "../src/projection.js";

describe("DeepSeek usage projection", () => {
  it("omits the cache hit rate when the harness reports no cache counters", () => {
    const usage = parseDeepSeekUsage({ inputTokens: 10, outputTokens: 4 });
    expect(usage).not.toBeNull();
    // The rate is a measurement of the cache counters: a harness that omits
    // them must not project as a 0% hit rate.
    expect(usage).not.toHaveProperty("cacheHitRatePercent");
    expect(usage).not.toHaveProperty("cachedInputTokens");
    expect(usage).toMatchObject({ inputTokens: 10, outputTokens: 4 });
  });

  it("passes reported cache reads through and derives the rate from billed input", () => {
    const usage = parseDeepSeekUsage({
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 5,
      cacheWriteTokens: 5,
    });
    expect(usage).toMatchObject({
      inputTokens: 10,
      cachedInputTokens: 5,
      cacheWriteInputTokens: 5,
    });
    expect(usage?.cacheHitRatePercent).toBeCloseTo((5 / 20) * 100, 10);
  });

  it("omits the rate when cache reads arrive without input tokens", () => {
    const usage = parseDeepSeekUsage({ outputTokens: 4, cacheReadTokens: 5 });
    expect(usage).not.toBeNull();
    expect(usage).toMatchObject({ cachedInputTokens: 5 });
    expect(usage).not.toHaveProperty("cacheHitRatePercent");
  });

  it("keeps a measured zero cache read as a zero rate", () => {
    const usage = parseDeepSeekUsage({ inputTokens: 10, outputTokens: 4, cacheReadTokens: 0 });
    expect(usage).toMatchObject({ cachedInputTokens: 0, cacheHitRatePercent: 0 });
  });
});
