import { describe, expect, it } from "vitest";

import { piUsageHistory, piUsageRecord } from "../src/pi-usage.js";

const assistant = {
  role: "assistant",
  provider: "my-alias",
  model: "claude-sonnet-4-5",
  responseId: "resp-1",
  timestamp: 1_700_000_000_000,
  usage: { input: 100, output: 40, cacheRead: 900, cacheWrite: 50, reasoning: 10 },
};

describe("Pi usage records", () => {
  it("adds cache back into input and keeps reasoning inside output", () => {
    expect(piUsageRecord(assistant, { outputStartedAtMs: 10, completedAtMs: 30 })).toEqual({
      kind: "request",
      request: {
        requestId: "resp-1",
        model: "claude-sonnet-4-5",
        inputTokens: 1_050,
        cachedInputTokens: 900,
        cacheWriteInputTokens: 50,
        outputTokens: 40,
        reasoningOutputTokens: 10,
        outputStartedAtMs: 10,
        completedAtMs: 30,
      },
    });
  });

  it("falls back to the message timestamp and omits unknown cache and timing", () => {
    const { responseId: _responseId, ...withoutResponse } = assistant;
    void _responseId;
    expect(
      piUsageRecord(
        { ...withoutResponse, usage: { input: 5, output: 1 } },
        { outputStartedAtMs: null, completedAtMs: 9 },
      ),
    ).toEqual({
      kind: "request",
      request: {
        requestId: "t1700000000000",
        model: "claude-sonnet-4-5",
        inputTokens: 5,
        outputTokens: 1,
      },
    });
  });

  it("ignores other roles and reports assistant messages without usable usage", () => {
    expect(piUsageRecord({ role: "user", content: "hi" })).toBeNull();
    expect(piUsageRecord({ ...assistant, usage: undefined })).toEqual({ kind: "missing" });
    expect(piUsageRecord({ ...assistant, usage: { input: -1, output: 1 } })).toEqual({
      kind: "missing",
    });
  });

  it("replays every branch of native history as historical requests", () => {
    const history = {
      leafId: "b",
      entries: [
        { type: "session", id: "s", parentId: null },
        { type: "message", id: "a", parentId: "s", message: assistant },
        {
          type: "message",
          id: "b",
          parentId: "s",
          message: { ...assistant, responseId: "resp-2" },
        },
        { type: "message", id: "u", parentId: "b", message: { role: "user", content: "x" } },
      ],
    };
    const replay = piUsageHistory(history);
    expect(replay.complete).toBe(true);
    expect(replay.requests.map((request) => [request.requestId, request.historical])).toEqual([
      ["resp-1", true],
      ["resp-2", true],
    ]);
    const broken = piUsageHistory({
      leafId: "a",
      entries: [{ type: "message", id: "a", parentId: null, message: { role: "assistant" } }],
    });
    expect(broken).toEqual({ requests: [], complete: false });
  });
});
