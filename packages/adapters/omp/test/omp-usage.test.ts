import { describe, expect, it } from "vitest";

import { ompUsageHistory, ompUsageRecord } from "../src/omp-usage.js";

describe("Omp usage records", () => {
  it("adds cache back into input and reads Omp's reasoningTokens", () => {
    expect(
      ompUsageRecord({
        role: "assistant",
        provider: "openai-codex",
        model: "gpt-5",
        responseId: "resp-1",
        usage: { input: 100, output: 20, cacheRead: 400, cacheWrite: 0, reasoningTokens: 9 },
      }),
    ).toEqual({
      kind: "request",
      request: {
        requestId: "resp-1",
        model: "gpt-5",
        inputTokens: 500,
        cachedInputTokens: 400,
        cacheWriteInputTokens: 0,
        outputTokens: 20,
        reasoningOutputTokens: 9,
      },
    });
  });

  it("replays history and flags assistant messages without usage", () => {
    expect(
      ompUsageHistory({
        leafId: "b",
        entries: [
          {
            type: "message",
            id: "a",
            parentId: null,
            message: { role: "assistant", timestamp: 5, usage: { input: 1, output: 1 } },
          },
          { type: "message", id: "b", parentId: "a", message: { role: "assistant" } },
        ],
      }),
    ).toEqual({
      requests: [{ requestId: "t5", historical: true, inputTokens: 1, outputTokens: 1 }],
      complete: false,
    });
  });
});
