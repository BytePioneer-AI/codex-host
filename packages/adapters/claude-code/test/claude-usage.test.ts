import { describe, expect, it } from "vitest";

import {
  claudePromptCacheFromMessages,
  claudePromptCacheIndicators,
  claudePromptCacheTtlSeconds,
} from "../src/claude-prompt-cache.js";
import { claudeUsageHistory, claudeUsageRecord } from "../src/claude-usage.js";
import { ClaudeNativeTurnAccumulator } from "../src/native-message.js";

// Shapes captured from Claude Code 2.1.289 (`--output-format stream-json --include-partial-messages`).
const startUsage = {
  input_tokens: 10,
  cache_creation_input_tokens: 8643,
  cache_read_input_tokens: 21000,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 8643 },
  output_tokens: 1,
  service_tier: "standard",
  inference_geo: "not_available",
};
const finalUsage = {
  input_tokens: 10,
  cache_creation_input_tokens: 8643,
  cache_read_input_tokens: 21000,
  output_tokens: 247,
  output_tokens_details: { thinking_tokens: 170 },
};
const metered = {
  requestId: "msg_1",
  model: "claude-haiku-4-5-20251001",
  inputTokens: 29653,
  cachedInputTokens: 21000,
  cacheWriteInputTokens: 8643,
  cacheWrite1hInputTokens: 8643,
  outputTokens: 247,
  reasoningOutputTokens: 170,
};

function stream(event: Record<string, unknown>, parent: string | null = null) {
  return { type: "stream_event", event, parent_tool_use_id: parent, session_id: "s" };
}

describe("Claude Code usage records", () => {
  it("adds cache back into input and keeps the one-hour write split", () => {
    expect(
      claudeUsageRecord("msg_1", "claude-haiku-4-5-20251001", {
        ...startUsage,
        ...finalUsage,
      }),
    ).toEqual({ kind: "request", request: metered });
  });

  it("meters each root stream message from start counts and final delta", () => {
    const turn = new ClaudeNativeTurnAccumulator();
    const message = { id: "msg_1", model: "claude-haiku-4-5-20251001", usage: startUsage };
    const events = [
      stream({ type: "message_start", message }),
      stream({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
      // The per-block assistant message repeats the start usage, with output_tokens: 1.
      { type: "assistant", message: { ...message, content: [{ type: "thinking", thinking: "" }] } },
      stream({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: finalUsage }),
      stream({ type: "message_stop" }),
      // A subagent's stream belongs to its own transcript.
      stream({ type: "message_start", message: { ...message, id: "msg_sub" } }, "toolu_1"),
      stream({ type: "message_stop" }, "toolu_1"),
    ].flatMap((value) => turn.consume(value).events);
    const records = events.filter((event) => event.type === "usage.request");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      record: { kind: "request", request: metered },
      promptCacheTtlSeconds: 3600,
    });
    const request = records[0]?.type === "usage.request" ? records[0].record : null;
    expect(request?.kind === "request" && request.request.startedAtMs).toEqual(expect.any(Number));
  });

  it.each(["aborted_streaming", "api_error"])(
    "marks an unfinished request missing at %s",
    (reason) => {
      const turn = new ClaudeNativeTurnAccumulator();
      turn.consume(
        stream({
          type: "message_start",
          message: { id: "msg_partial", model: "claude-haiku-4-5-20251001", usage: startUsage },
        }),
      );
      turn.consume(
        stream({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
      );
      if (reason === "aborted_streaming") turn.requestCancel();
      const { events } = turn.consume({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: reason,
      });
      expect(events.filter((event) => event.type === "usage.request")).toEqual([
        { type: "usage.request", record: { kind: "missing" } },
      ]);
    },
  );

  it("does not invent a usage gap when cancellation precedes any model request", () => {
    const turn = new ClaudeNativeTurnAccumulator();
    turn.requestCancel();
    const { events } = turn.consume({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      terminal_reason: "aborted_streaming",
    });
    expect(events.filter((event) => event.type === "usage.request")).toEqual([]);
  });

  it("replays one request per message ID and skips synthetic messages", () => {
    const entry = (
      id: string,
      model: string,
      usage: unknown = { ...startUsage, ...finalUsage },
    ) => ({
      type: "assistant",
      uuid: `${id}-${Math.random()}`,
      message: { id, model, usage, content: [] },
    });
    expect(
      claudeUsageHistory([
        entry("msg_1", "claude-haiku-4-5-20251001"),
        entry("msg_1", "claude-haiku-4-5-20251001"),
        entry("msg_err", "<synthetic>", { input_tokens: 0, output_tokens: 0 }),
        { type: "user", message: { role: "user", content: "hi" } },
      ]),
    ).toEqual({ requests: [{ ...metered, historical: true }], complete: true });
    expect(claudeUsageHistory([entry("msg_2", "claude-opus-5-5", null)]).complete).toBe(false);
  });
});

describe("Claude Code prompt cache TTL", () => {
  it.each([
    ["5m write", { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 0 }, 300],
    ["1h write", { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 8643 }, 3600],
    [
      "mixed 5m + 1h write uses shorter 5m TTL",
      { ephemeral_5m_input_tokens: 120, ephemeral_1h_input_tokens: 8643 },
      300,
    ],
    [
      "zero split tokens",
      { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      undefined,
    ],
    ["absent cache_creation", undefined, undefined],
  ] as const)("resolves TTL for %s", (_label, cacheCreation, expectedTtl) => {
    const usage = cacheCreation
      ? { cache_creation: cacheCreation }
      : { cache_read_input_tokens: 100 };
    expect(claudePromptCacheTtlSeconds(usage)).toBe(expectedTtl);
    const indicators = claudePromptCacheIndicators(true, 1_800_000_000, expectedTtl);
    if (expectedTtl === undefined) {
      expect(indicators).toEqual([]);
    } else {
      expect(indicators).toEqual([
        {
          kind: "countdown",
          id: "prompt-cache",
          expiresAtUnix: 1_800_000_000 + expectedTtl,
          label: { en: "Prompt cache", "zh-CN": "提示词缓存" },
        },
      ]);
    }
  });

  it("inherits the latest main-session write TTL on cache-read-only replies and excludes sidechains", () => {
    const history = claudePromptCacheFromMessages([
      {
        type: "assistant",
        timestamp: "2026-08-01T10:00:00Z",
        message: {
          model: "claude-opus-4-6",
          usage: {
            cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 4000 },
          },
        },
      },
      {
        type: "assistant",
        isSidechain: true,
        timestamp: "2026-08-01T10:05:00Z",
        message: {
          model: "claude-haiku-4-5",
          usage: {
            cache_creation: { ephemeral_5m_input_tokens: 900, ephemeral_1h_input_tokens: 0 },
          },
        },
      },
      {
        type: "assistant",
        parent_tool_use_id: "toolu_sub",
        timestamp: "2026-08-01T10:06:00Z",
        message: {
          model: "claude-haiku-4-5",
          usage: {
            cache_creation: { ephemeral_5m_input_tokens: 900, ephemeral_1h_input_tokens: 0 },
          },
        },
      },
      {
        type: "assistant",
        timestamp: "2026-08-01T10:10:00Z",
        message: {
          model: "claude-opus-4-6",
          usage: { cache_read_input_tokens: 21000, cache_creation_input_tokens: 0 },
        },
      },
      {
        type: "assistant",
        timestamp: "2026-08-01T10:12:00Z",
        message: { model: "<synthetic>", usage: { input_tokens: 0, output_tokens: 0 } },
      },
    ]);
    expect(history).toEqual({
      lastResponseAtUnix: Date.parse("2026-08-01T10:10:00Z") / 1000,
      ttlSeconds: 3600,
    });
  });

  it("omits TTL when history contains no explicit 5m or 1h cache write", () => {
    expect(
      claudePromptCacheFromMessages([
        {
          type: "assistant",
          timestamp: "2026-08-01T10:00:00Z",
          message: {
            model: "claude-opus-4-6",
            usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 2000 },
          },
        },
      ]),
    ).toEqual({
      lastResponseAtUnix: Date.parse("2026-08-01T10:00:00Z") / 1000,
    });
  });
});
