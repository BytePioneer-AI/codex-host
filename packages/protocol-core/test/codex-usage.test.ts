import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import { projectCodexThreadUsage } from "../src/index.js";

describe("Codex Thread Usage projection", () => {
  it("projects the reviewed total, context carrier, and Model window structure", () => {
    const usage = {
      inputTokens: 100,
      cachedInputTokens: 20,
      cacheWriteInputTokens: 5,
      outputTokens: 30,
      reasoningOutputTokens: 7,
      totalTokens: 162,
      totalCostUsd: 0.5,
      contextUsedTokens: 240,
      contextWindowTokens: 200,
    };
    const original = structuredClone(usage);

    expect(
      projectCodexThreadUsage({
        threadId: "thread-usage",
        turnId: hostTurnIdSchema.parse("turn-usage"),
        usage,
      }),
    ).toEqual({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-usage",
        turnId: "turn-usage",
        tokenUsage: {
          total: {
            totalTokens: 162,
            inputTokens: 100,
            cachedInputTokens: 20,
            cacheWriteInputTokens: 5,
            outputTokens: 30,
            reasoningOutputTokens: 7,
          },
          last: {
            totalTokens: 240,
            inputTokens: 240,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
          },
          modelContextWindow: 200,
        },
      },
    });
    expect(usage).toEqual(original);
  });

  it("fills required aggregate carrier components without changing canonical unknowns", () => {
    expect(
      projectCodexThreadUsage({
        threadId: "thread-minimal",
        turnId: hostTurnIdSchema.parse("turn-minimal"),
        usage: {
          totalTokens: 0,
          contextUsedTokens: 0,
          contextWindowTokens: 100,
        },
      }),
    ).toMatchObject({
      params: {
        tokenUsage: {
          total: {
            totalTokens: 0,
            inputTokens: 0,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
          },
        },
      },
    });
  });

  it("omits Usage without a reliable Host Turn", () => {
    expect(
      projectCodexThreadUsage({
        threadId: "thread-no-turn",
        usage: { totalTokens: 10, contextUsedTokens: 5, contextWindowTokens: 100 },
      }),
    ).toBeNull();
  });

  it.each([
    { contextUsedTokens: 10, contextWindowTokens: 100 },
    { totalTokens: 10, contextWindowTokens: 100 },
    { totalTokens: 10, contextUsedTokens: 5 },
  ])("omits snapshots that cannot drive the reviewed carrier %#", (usage) => {
    expect(
      projectCodexThreadUsage({
        threadId: "thread-invalid",
        turnId: hostTurnIdSchema.parse("turn-invalid"),
        usage,
      }),
    ).toBeNull();
  });
});
