import type { AssistantMessage } from "@opencode-ai/sdk/v2";
import { describe, expect, it } from "vitest";

import { projectOpenCodeUsage } from "../src/usage.js";

function assistant(id: string, tokens: AssistantMessage["tokens"], cost: number): AssistantMessage {
  return {
    id,
    sessionID: "session-1",
    role: "assistant",
    time: { created: 1, completed: 2 },
    parentID: `user-${id}`,
    modelID: "model",
    providerID: "provider",
    mode: "build",
    agent: "build",
    path: { cwd: "/synthetic", root: "/synthetic" },
    cost,
    tokens,
    finish: "stop",
  };
}

describe("OpenCode Usage projection", () => {
  it("aggregates billing tokens and uses only the latest request for context occupancy", () => {
    const usage = projectOpenCodeUsage(
      [
        assistant(
          "one",
          { input: 100, output: 20, reasoning: 10, cache: { read: 50, write: 5 } },
          0.1,
        ),
        assistant(
          "two",
          {
            total: 270,
            input: 120,
            output: 30,
            reasoning: 20,
            cache: { read: 80, write: 20 },
          },
          0.2,
        ),
      ],
      1_000,
    );

    expect(usage).toMatchObject({
      inputTokens: 220,
      cachedInputTokens: 130,
      cacheWriteInputTokens: 25,
      outputTokens: 50,
      reasoningOutputTokens: 30,
      totalTokens: 455,
      contextUsedTokens: 220,
      contextWindowTokens: 1_000,
    });
    expect(usage?.totalCostUsd).toBeCloseTo(0.3, 12);
  });

  it("returns null without Assistant usage", () => {
    expect(projectOpenCodeUsage([])).toBeNull();
  });
});
