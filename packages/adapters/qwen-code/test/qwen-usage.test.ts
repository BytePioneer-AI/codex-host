import { describe, expect, it } from "vitest";

import { combineUsage, usageFromMetadata } from "../src/index.js";

describe("Qwen SDK Usage", () => {
  it("projects SDK snake_case ExtendedUsage", () => {
    expect(
      usageFromMetadata({
        usage: {
          input_tokens: 45_091,
          output_tokens: 14,
          total_tokens: 45_105,
          thinking_tokens: 12,
          cache_read_input_tokens: 20,
        },
      }),
    ).toEqual({
      inputTokens: 45_091,
      outputTokens: 14,
      totalTokens: 45_105,
      reasoningOutputTokens: 12,
      cachedInputTokens: 20,
    });
  });

  it("rejects a metadata envelope with no usable Usage fields", () => {
    expect(usageFromMetadata(undefined)).toBeNull();
    expect(usageFromMetadata({ timestamp: 1 })).toBeNull();
    expect(usageFromMetadata({ usage: { input_tokens: "many" } })).toBeNull();
  });

  it("merges Usage snapshots with later values winning", () => {
    const base = usageFromMetadata({ usage: { input_tokens: 10, total_tokens: 20 } });
    const next = usageFromMetadata({ usage: { input_tokens: 30, output_tokens: 5 } });
    expect(combineUsage(null, base)).toEqual(base);
    expect(combineUsage(base, next)).toEqual({ inputTokens: 30, outputTokens: 5, totalTokens: 20 });
    expect(combineUsage(base, null)).toEqual(base);
  });
});
