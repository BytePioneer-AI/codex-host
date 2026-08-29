import { describe, expect, it } from "vitest";

import { estimateClaudeRequestCostUsd } from "../src/usage-estimate.js";

const usage = {
  requestId: "request-1",
  model: "claude-sonnet-4-6",
  provider: "firstParty",
  inputTokens: 100_000,
  outputTokens: 10_000,
  cacheCreationInputTokens: 20_000,
  cacheReadInputTokens: 500_000,
} as const;

describe("Claude request cost estimate", () => {
  it("prices actual first-party Sonnet request attribution including cache categories", () => {
    expect(estimateClaudeRequestCostUsd(usage)).toBeCloseTo(0.3 + 0.075 + 0.15 + 0.15, 12);
  });

  it("does not price an unknown model or third-party Provider", () => {
    const usageWithoutModel = {
      requestId: usage.requestId,
      provider: usage.provider,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
    };
    const usageWithoutProvider = {
      requestId: usage.requestId,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
    };

    expect(estimateClaudeRequestCostUsd({ ...usage, model: "custom-model" })).toBeUndefined();
    expect(estimateClaudeRequestCostUsd({ ...usage, provider: "bedrock" })).toBeUndefined();
    expect(estimateClaudeRequestCostUsd(usageWithoutProvider)).toBeUndefined();
    expect(estimateClaudeRequestCostUsd(usageWithoutModel)).toBeUndefined();
  });
});
