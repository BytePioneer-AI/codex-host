import { describe, expect, it } from "vitest";

import { usageFromTurnResult } from "../src/usage.js";
import type { CodeBuddyTurnResult } from "../src/stream-protocol.js";

function turnResult(overrides: Partial<CodeBuddyTurnResult> = {}): CodeBuddyTurnResult {
  return {
    outcome: "succeeded",
    is_error: false,
    resultText: "",
    totalCostUsd: null,
    usage: null,
    modelUsage: {},
    meta: null,
    sessionId: "s-1",
    ...overrides,
  };
}

describe("usageFromTurnResult", () => {
  it("returns null when neither usage nor modelUsage is present", () => {
    expect(usageFromTurnResult(turnResult(), null)).toBeNull();
  });

  it("maps token counters from the terminal usage block", () => {
    const usage = usageFromTurnResult(
      turnResult({
        usage: {
          input_tokens: 120,
          output_tokens: 45,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5,
        },
      }),
      null,
    );
    expect(usage).toMatchObject({
      inputTokens: 120,
      outputTokens: 45,
      cachedInputTokens: 10,
      cacheWriteInputTokens: 5,
    });
  });

  it("prefers the requested model's context window and derives contextUsed from meta", () => {
    const usage = usageFromTurnResult(
      turnResult({
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: {
          "gpt-5.6-sol": { contextWindow: 272_000 },
          "other-model": { contextWindow: 128_000 },
        },
        meta: { "codebuddy.ai/contextUsed": 54_000 },
      }),
      "gpt-5.6-sol",
    );
    expect(usage?.contextWindowTokens).toBe(272_000);
    expect(usage?.contextUsedTokens).toBe(54_000);
  });

  it("carries a finite non-negative total cost", () => {
    const usage = usageFromTurnResult(turnResult({ totalCostUsd: 0.0123 }), null);
    expect(usage?.totalCostUsd).toBe(0.0123);
    const invalid = usageFromTurnResult(turnResult({ totalCostUsd: Number.NaN }), null);
    expect(invalid?.totalCostUsd).toBeUndefined();
  });

  it("returns null when every candidate field is invalid", () => {
    const usage = usageFromTurnResult(
      turnResult({
        usage: { input_tokens: -1, output_tokens: Number.NaN },
        totalCostUsd: -5,
      }),
      null,
    );
    expect(usage).toBeNull();
  });
});
