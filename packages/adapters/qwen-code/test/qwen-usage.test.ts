import { describe, expect, it } from "vitest";

import { combineUsage, usageFromMetadata, usageFromUpdate } from "../src/index.js";

describe("Qwen Code Usage", () => {
  it("parses cumulative metadata Usage from message chunks", () => {
    const usage = usageFromMetadata({
      usage: { inputTokens: 45_091, outputTokens: 14, totalTokens: 45_105, thoughtTokens: 12 },
    });
    expect(usage).toEqual({
      inputTokens: 45_091,
      outputTokens: 14,
      totalTokens: 45_105,
      reasoningOutputTokens: 12,
    });
  });

  it("ignores metadata without a Usage payload", () => {
    expect(usageFromMetadata(undefined)).toBeNull();
    expect(usageFromMetadata({ timestamp: 1 })).toBeNull();
    expect(usageFromMetadata({ usage: { inputTokens: "many" } })).toBeNull();
  });

  it("maps usage_update to context Utilization", () => {
    const usage = usageFromUpdate(
      { sessionUpdate: "usage_update", used: 45_091, size: 1_000_000 } as Parameters<
        typeof usageFromUpdate
      >[0],
      undefined,
      undefined,
    );
    expect(usage).toEqual({ contextUsedTokens: 45_091, contextWindowTokens: 1_000_000 });
  });

  it("combines context fields from usage_update with metadata totals", () => {
    const usage = usageFromUpdate(undefined, { usage: { totalTokens: 45_105 } }, 1_000_000);
    expect(usage).toEqual({
      totalTokens: 45_105,
      contextUsedTokens: 45_105,
      contextWindowTokens: 1_000_000,
    });
  });

  it("merges Usage snapshots with later values winning", () => {
    const base = usageFromMetadata({ usage: { inputTokens: 10, totalTokens: 20 } });
    const next = usageFromMetadata({ usage: { inputTokens: 30, outputTokens: 5 } });
    expect(combineUsage(null, base)).toEqual(base);
    expect(combineUsage(base, next)).toEqual({ inputTokens: 30, outputTokens: 5, totalTokens: 20 });
    expect(combineUsage(base, null)).toEqual(base);
    expect(combineUsage(null, null)).toBeNull();
  });
});
