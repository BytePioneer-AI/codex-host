import { describe, expect, it } from "vitest";

import { historyUsage, historyUsageRequests } from "../src/history.js";

// `providerData.rawUsage` captured from local CodeBuddy history (deepseek-v4.1-flash).
const rawUsage = {
  prompt_tokens: 20093,
  completion_tokens: 279,
  total_tokens: 20372,
  completion_tokens_details: { reasoning_tokens: 17, cached_tokens: 0 },
  prompt_tokens_details: { reasoning_tokens: 0, cached_tokens: 17664 },
  prompt_cache_hit_tokens: 17664,
  prompt_cache_miss_tokens: 2429,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  prompt_cache_write_tokens: 0,
  completion_thinking_tokens: 17,
  credit: 0.11,
  cached_tokens: 0,
};

function row(id: string, parentId: string | null, type: string, data: Record<string, unknown>) {
  return JSON.stringify({ id, parentId, timestamp: 1, type, providerData: data });
}

function history(...rows: string[]) {
  return rows.join("\n") + "\n";
}

const provider = { messageId: "msg-1", model: "deepseek-v4.1-flash", rawUsage };

describe("CodeBuddy usage records", () => {
  it("meters one request per messageId with cached input from prompt_tokens_details", () => {
    expect(
      historyUsageRequests(
        history(
          row("r1", null, "reasoning", provider),
          row("r2", "r1", "function_call", provider),
          row("r3", "r2", "function_call_result", {}),
        ),
        true,
      ),
    ).toEqual({
      requests: [
        {
          requestId: "msg-1",
          historical: true,
          model: "deepseek-v4.1-flash",
          inputTokens: 20093,
          cachedInputTokens: 17664,
          cacheWriteInputTokens: 0,
          outputTokens: 279,
          reasoningOutputTokens: 17,
        },
      ],
      complete: true,
    });
  });

  it("replays all native branches so reopening retains requests already counted live", () => {
    const root = row("root", null, "message", provider);
    const oldBranch = row("old", "root", "message", { ...provider, messageId: "msg-old" });
    const newBranch = row("new", "root", "message", { ...provider, messageId: "msg-new" });
    const before = historyUsageRequests(history(root, oldBranch), true);
    const live = historyUsageRequests(history(root, oldBranch, newBranch), false);
    const reopened = historyUsageRequests(history(root, oldBranch, newBranch), true);
    const liveIds = new Set([...before.requests, ...live.requests].map((r) => r.requestId));
    expect([...liveIds]).toEqual(["msg-1", "msg-old", "msg-new"]);
    expect(reopened.requests.map((r) => r.requestId)).toEqual([...liveIds]);
    expect(reopened.complete).toBe(true);
  });

  it("leaves requests with unverified Anthropic-style cache fields unmetered", () => {
    const unverified = { ...provider, rawUsage: { ...rawUsage, cache_read_input_tokens: 5 } };
    expect(historyUsageRequests(history(row("r1", null, "reasoning", unverified)), true)).toEqual({
      requests: [],
      complete: false,
    });
  });

  it("reads prompt cache writes, which prompt_tokens includes", () => {
    // Captured from WorkBuddy (gpt-5.6-luna): 24963 written + 3 missed = 24966 prompt.
    const writes = {
      ...provider,
      model: "gpt-5.6-luna",
      rawUsage: {
        ...rawUsage,
        prompt_tokens: 24966,
        completion_tokens: 14,
        prompt_tokens_details: { cached_tokens: 0 },
        prompt_cache_hit_tokens: 0,
        prompt_cache_miss_tokens: 3,
        prompt_cache_write_tokens: 24963,
        completion_thinking_tokens: 0,
      },
    };
    expect(
      historyUsageRequests(history(row("r1", null, "reasoning", writes)), true).requests[0],
    ).toMatchObject({ inputTokens: 24966, cachedInputTokens: 0, cacheWriteInputTokens: 24963 });
  });

  it("reports the same cached input in the native session snapshot", () => {
    expect(historyUsage(history(row("r1", null, "reasoning", provider)))).toMatchObject({
      inputTokens: 20093,
      cachedInputTokens: 17664,
      cacheWriteInputTokens: 0,
    });
  });

  it("reports the latest request's cache rate, not the cumulative rate or duplicate tool rows", () => {
    const latest = {
      ...provider,
      messageId: "latest",
      rawUsage: {
        ...rawUsage,
        prompt_tokens: 200,
        prompt_tokens_details: { cached_tokens: 20 },
        prompt_cache_write_tokens: 50,
      },
    };
    const contents = history(
      row("old", null, "message", provider),
      row("tool", "old", "function_call", latest),
      row("reply", "tool", "message", latest),
    );
    expect(historyUsage(contents)).toMatchObject({
      inputTokens: 20293,
      cachedInputTokens: 17684,
      cacheHitRatePercent: 10,
    });
    // Restore an earlier native branch: CH follows that branch, not append-only file order.
    expect(
      historyUsage(contents + JSON.stringify({ type: "resend-fork-notice", parentId: "old" })),
    ).toMatchObject({ cacheHitRatePercent: (17664 / 20093) * 100 });
  });

  it.each([
    [100, 0, 0],
    [100, 100, 100],
    [0, 0, undefined],
    [100, undefined, undefined],
    [100, -1, undefined],
    [100, 101, undefined],
  ])(
    "handles recent input %s / cache %s without fabricating a percentage",
    (input, cached, expected) => {
      const latest = {
        ...provider,
        messageId: "latest",
        rawUsage: {
          ...rawUsage,
          prompt_tokens: input,
          prompt_tokens_details: { cached_tokens: cached },
        },
      };
      const usage = historyUsage(
        history(row("old", null, "message", provider), row("latest", "old", "message", latest)),
      );
      expect(usage?.cacheHitRatePercent).toBe(expected);
      if (expected === undefined) expect(usage).not.toHaveProperty("cacheHitRatePercent");
    },
  );

  it("skips subagent requests recorded in the parent history", () => {
    const sub = { ...provider, messageId: "msg-sub", isSubAgent: true };
    expect(historyUsageRequests(history(row("r1", null, "reasoning", sub)), true).requests).toEqual(
      [],
    );
  });
});
