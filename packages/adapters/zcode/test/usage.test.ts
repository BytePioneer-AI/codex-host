import { describe, expect, it } from "vitest";
import type { HostEvent } from "@codexhost/harness-adapter";
import { messageSchema, type NativeEvent } from "../src/protocol.js";
import { ZcodeUsage, zcodeUsageRecord } from "../src/usage.js";

// Shape and counts from ZCode 3.14.4 session/resume (local GLM/GPT histories).
// Identities are synthetic; no conversation text, account names or credentials are retained.
const tokens = {
  total: 18880,
  input: 18738,
  output: 142,
  reasoning: 0,
  cache: { read: 9792, write: 0 },
};
function message(info: Record<string, unknown> = {}) {
  return messageSchema.parse({
    info: {
      sessionId: "session",
      messageId: "message",
      role: "assistant",
      model: { providerId: "account:fixture", modelId: "GLM-5.3-Flash" },
      semantics: { origin: "agent_runtime", kind: "assistant_response" },
      time: { created: 100, completed: 300 },
      finish: "stop",
      tokens,
      ...info,
    },
    // The native step-finish repeats usage; it must not count as a second request.
    parts: [
      { type: "step-finish", sessionId: "session", messageId: "message", partId: "part", tokens },
    ],
  });
}
function fixture() {
  const events: HostEvent[] = [];
  const meter = new ZcodeUsage("session", (e) => events.push(e));
  const send = (
    type: string,
    payload: Record<string, unknown> = {},
    timestamp = 200,
    turnId = "turn",
  ) =>
    meter.observe({
      type,
      payload,
      timestamp,
      turnId,
      eventId: "event",
      seq: 1,
      sessionId: "session",
    });
  const start = (requestId = "request", modelId = "GLM-5.3-Flash") =>
    send(
      "session.updated",
      {
        type: "model_request_started",
        querySource: "main_turn",
        requestId,
        modelId,
      },
      100,
    );
  const output = (kind = "text_delta", id = "message", timestamp = 200) =>
    send(
      "model.streaming",
      {
        kind,
        assistantMessageId: id,
        delta: "output",
      },
      timestamp,
    );
  const complete = (
    usage: Record<string, unknown> = {},
    modelId = "GLM-5.3-Flash",
    requestId = "request",
  ) =>
    send(
      "session.updated",
      {
        type: "model_request_completed",
        querySource: "main_turn",
        requestId,
        modelId,
        usage: {
          inputTokens: 18738,
          outputTokens: 142,
          totalTokens: 18880,
          cacheReadTokens: 9792,
          cacheWriteTokens: 0,
          ...usage,
        },
      },
      300,
    );
  const requests = () => events.flatMap((e) => (e.type === "usage.request" ? [e.request] : []));
  return { meter, events, send, start, output, complete, requests };
}

describe("ZCode normalized request usage", () => {
  it("keeps message tokens through the protocol schema and includes cache only once", () => {
    expect(zcodeUsageRecord(message())).toEqual({
      kind: "request",
      request: {
        requestId: "message",
        model: "GLM-5.3-Flash",
        inputTokens: 18738,
        outputTokens: 142,
        cachedInputTokens: 9792,
        cacheWriteInputTokens: 0,
        reasoningOutputTokens: 0,
      },
    });
  });
  it("keeps reasoning inside output, as verified by a native GPT response", () => {
    const result = zcodeUsageRecord(
      message({
        tokens: {
          total: 16691,
          input: 16589,
          output: 102,
          reasoning: 66,
          cache: { read: 0, write: 0 },
        },
      }),
    );
    expect(result).toMatchObject({
      request: { inputTokens: 16589, outputTokens: 102, reasoningOutputTokens: 66 },
    });
  });
  it("does not turn absent cache details or an absent model into zero/selected model", () => {
    expect(
      zcodeUsageRecord(message({ model: undefined, tokens: { input: 20, output: 4, total: 24 } })),
    ).toEqual({
      kind: "request",
      request: { requestId: "message", inputTokens: 20, outputTokens: 4 },
    });
  });
  it.each([
    { input: 20, output: 4, total: 30, cache: { read: 6, write: 0 } },
    { input: -1, output: 4, total: 3 },
    { input: 20, output: 4, total: 24, reasoning: 5 },
    { input: 20, output: 4, total: 24, cache: { read: 21, write: 0 } },
    { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    undefined,
    "invalid",
  ])(
    "rejects unknown conventions, invalid data and provider-less zero placeholders: %j",
    (value) => {
      expect(zcodeUsageRecord(message({ tokens: value }))).toEqual({ kind: "missing" });
    },
  );
  it("does not count synthetic timeline rows or user messages", () => {
    for (const info of [
      { role: "user" },
      { synthetic: true },
      { semantics: { origin: "system", kind: "timeline_event" } },
    ])
      expect(zcodeUsageRecord(message(info))).toEqual({ kind: "none" });
  });
  it("does not accept an unfinished assistant message", () => {
    expect(zcodeUsageRecord(message({ time: { created: 100 } }))).toEqual({ kind: "missing" });
  });
});

describe("ZCode history and live metering", () => {
  it("replays history by message id, deduplicates step-finish, and uses each message's model", () => {
    const f = fixture();
    const second = message({
      messageId: "other",
      model: { providerId: "personal", modelId: "gpt-5.6-sol" },
    });
    f.meter.replay([message(), second], true);
    f.meter.replay([message(), second], false);
    expect(f.requests()).toHaveLength(2);
    expect(f.requests().map((r) => [r.model, r.historical])).toEqual([
      ["GLM-5.3-Flash", true],
      ["gpt-5.6-sol", true],
    ]);
    expect(f.events.at(-1)).toEqual({ type: "usage.history", complete: true });
  });
  it("declares new empty sessions complete", () => {
    const f = fixture();
    f.meter.replay([], true);
    expect(f.events).toEqual([{ type: "usage.history", complete: true }]);
  });
  it("excludes child session records", () => {
    const f = fixture();
    f.meter.replay([message({ sessionId: "child" })], true);
    expect(f.requests()).toHaveLength(0);
  });
  it.each(["text_delta", "reasoning_delta", "tool_input_start", "tool_input_delta", "tool_call"])(
    "times %s within its correlated request, not prefill or tool execution",
    (kind) => {
      const f = fixture();
      f.meter.replay([], true);
      f.start();
      f.output(kind);
      f.complete();
      expect(f.requests()).toHaveLength(1);
      expect(f.requests()[0]).toMatchObject({
        requestId: "message",
        startedAtMs: 200,
        completedAtMs: 300,
      });
      f.meter.replay([message({ time: { created: 100, completed: 9999 } })], false);
      expect(f.requests()).toHaveLength(1);
      expect(f.events.filter((e) => e.type === "usage.history")).toEqual([
        { type: "usage.history", complete: true },
      ]);
    },
  );
  it("defers missing stream cache details to the final snapshot without losing measured timing", () => {
    const f = fixture();
    f.start();
    f.output();
    f.complete({ cacheWriteTokens: undefined });
    expect(f.requests()).toHaveLength(0);
    f.meter.replay([message()], false);
    expect(f.requests()[0]).toMatchObject({
      cachedInputTokens: 9792,
      cacheWriteInputTokens: 0,
      startedAtMs: 200,
      completedAtMs: 300,
    });
  });
  it("omits speed when reported reasoning cannot be timed from this protocol", () => {
    const f = fixture();
    f.start();
    f.output();
    f.complete({ reasoningTokens: 66 });
    expect(f.requests()[0]).toMatchObject({ outputTokens: 142, reasoningOutputTokens: 66 });
    expect(f.requests()[0]?.startedAtMs).toBeUndefined();
    const h = fixture();
    h.start();
    h.output();
    h.complete({ cacheWriteTokens: undefined });
    h.meter.replay([message({ tokens: { ...tokens, reasoning: 66 } })], false);
    expect(h.requests()[0]?.startedAtMs).toBeUndefined();
  });
  it("does not attach previous-turn timing to late or historical records", () => {
    const f = fixture();
    f.start();
    f.output();
    f.complete({ cacheWriteTokens: undefined });
    f.send("turn.started", {}, 400, "next");
    f.meter.replay([message()], false);
    expect(f.requests()[0]?.startedAtMs).toBeUndefined();
    const h = fixture();
    h.start();
    h.output();
    h.complete({ cacheWriteTokens: undefined });
    h.meter.replay([message()], true);
    expect(h.requests()[0]?.startedAtMs).toBeUndefined();
  });
  it("omits timing without a correlated start or with reversed timestamps", () => {
    const f = fixture();
    f.start();
    f.output("text_delta", "message", 500);
    f.complete();
    expect(f.requests()[0]?.startedAtMs).toBeUndefined();
    const h = fixture();
    h.output();
    h.complete();
    h.meter.replay([message()], false);
    expect(h.requests()[0]?.startedAtMs).toBeUndefined();
  });
  it("does not guess request attribution with interleaved messages, requests or a mismatched model", () => {
    for (const interfere of [
      (f: ReturnType<typeof fixture>) => f.output("text_delta", "other"),
      (f: ReturnType<typeof fixture>) => f.start("another"),
      (f: ReturnType<typeof fixture>) => f.start("request", "changed"),
    ]) {
      const f = fixture();
      f.start();
      f.output();
      interfere(f);
      f.complete();
      expect(f.requests()).toHaveLength(0);
      f.meter.replay([message()], false);
      expect(f.requests()[0]?.startedAtMs).toBeUndefined();
    }
  });
  it("ignores child and background traffic without changing main request timing", () => {
    const f = fixture();
    f.start();
    f.send("session.updated", {
      type: "model_request_started",
      querySource: "title_generation",
      requestId: "title",
      modelId: "small",
    });
    const child: NativeEvent = {
      type: "model.streaming",
      eventId: "child",
      seq: 2,
      sessionId: "child",
      turnId: "turn",
      timestamp: 150,
      payload: { kind: "text_delta", delta: "child", assistantMessageId: "child" },
    };
    f.meter.observe(child);
    f.output();
    f.complete();
    expect(f.requests()[0]).toMatchObject({ requestId: "message", startedAtMs: 200 });
  });
  it("latches incompleteness after a malformed request but skips native failed requests without usage", () => {
    const f = fixture();
    f.meter.replay([], true);
    f.start();
    f.output();
    f.complete({ totalTokens: 1 });
    f.meter.replay([message()], false);
    expect(f.events.filter((e) => e.type === "usage.history")).toEqual([
      { type: "usage.history", complete: true },
      { type: "usage.history", complete: false },
    ]);
    const h = fixture();
    h.meter.replay(
      [
        message({
          error: { name: "cancelled" },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
      ],
      true,
    );
    expect(h.requests()).toHaveLength(0);
    expect(h.events.at(-1)).toEqual({ type: "usage.history", complete: true });
  });
  it("invalidates instead of silently keeping a conflicting final request", () => {
    const f = fixture();
    f.start();
    f.output();
    f.complete();
    f.meter.replay([message({ tokens: { ...tokens, total: 18881, output: 143 } })], false);
    expect(f.events.at(-1)).toEqual({ type: "usage.history", complete: false });
    expect(f.requests()).toHaveLength(1);
  });
});
