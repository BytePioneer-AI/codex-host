import { afterEach, describe, expect, it, vi } from "vitest";
import { GrokTurnUsage } from "../src/grok-usage.js";
import type { GrokTransportEvent } from "../src/acp-transport.js";

const response = (output = 20, messageId = "one"): GrokTransportEvent => ({
  type: "response.completed",
  messageId,
  usage: {
    input_tokens: 70,
    cache_read_input_tokens: 20,
    cache_creation_input_tokens: 10,
    output_tokens: output,
    reasoning_tokens: 5,
  },
});

afterEach(() => vi.restoreAllMocks());

describe("Grok live response usage", () => {
  it("updates after each request, excluding tool waits and weighting durations", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const usage = new GrokTurnUsage(null, true);
    usage.observe({ type: "agent.thought", text: "thinking" });
    clock.mockReturnValue(2000);
    expect(usage.observe(response())).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      reasoningOutputTokens: 5,
      cacheHitRatePercent: 20,
      outputTokensPerSecond: 20,
      sessionCacheUsage: { inputTokens: 100, cachedInputTokens: 20 },
    });
    clock.mockReturnValue(3000);
    usage.observe({ type: "tool.call", callId: "tool", title: "sleep" });
    clock.mockReturnValue(10000);
    usage.observe({ type: "agent.text", text: "answer" });
    clock.mockReturnValue(13000);
    expect(usage.observe(response(100, "two"))).toMatchObject({
      inputTokens: 200,
      outputTokens: 120,
      outputTokensPerSecond: 30,
      sessionCacheUsage: { inputTokens: 200, cachedInputTokens: 40 },
    });
  });

  it("times tool-only output from native tool argument deltas", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const usage = new GrokTurnUsage(null, true);
    usage.observe({ type: "tool.input.delta", text: '{"command":' });
    clock.mockReturnValue(2000);
    expect(usage.observe(response())?.outputTokensPerSecond).toBe(20);
  });

  it("counts native reasoning once even when only text is observable", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const usage = new GrokTurnUsage(null, true);
    usage.observe({ type: "agent.text", text: "answer" });
    clock.mockReturnValue(3000);
    expect(usage.observe(response(100))?.outputTokensPerSecond).toBe(50);
  });

  it("retains valid timed requests when another request has no observable output", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const usage = new GrokTurnUsage(null, true);
    usage.observe({ type: "agent.text", text: "answer" });
    clock.mockReturnValue(2000);
    usage.observe(response());
    clock.mockReturnValue(9000);
    expect(usage.observe(response(100, "untimed"))).toMatchObject({
      outputTokens: 120,
      outputTokensPerSecond: 20,
    });
  });

  it("deduplicates native message IDs without discarding a new request's start", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const usage = new GrokTurnUsage(null, true);
    usage.observe({ type: "agent.text", text: "one" });
    clock.mockReturnValue(2000);
    usage.observe(response());
    clock.mockReturnValue(3000);
    usage.observe({ type: "agent.text", text: "two" });
    expect(usage.observe(response())).toBeNull();
    clock.mockReturnValue(4000);
    expect(usage.observe(response(100, "two"))).toMatchObject({
      inputTokens: 200,
      outputTokens: 120,
      outputTokensPerSecond: 60,
    });
  });

  it("adds live usage to complete history, not to previous live snapshots", () => {
    const usage = new GrokTurnUsage({
      inputTokens: 300,
      cachedInputTokens: 200,
      outputTokens: 50,
      sessionCacheUsage: { inputTokens: 300, cachedInputTokens: 200 },
    });
    expect(usage.observe(response())).toMatchObject({
      inputTokens: 400,
      cachedInputTokens: 220,
      outputTokens: 70,
      cacheHitRatePercent: 20,
      sessionCacheUsage: { inputTokens: 400, cachedInputTokens: 220 },
    });
    expect(usage.observe(response(20, "two"))?.inputTokens).toBe(500);
  });

  it("does not promote incomplete history or missing cache buckets to complete totals", () => {
    const unknown = new GrokTurnUsage({ inputTokens: 100 });
    expect(unknown.observe(response())).not.toHaveProperty("sessionCacheUsage");
    const usage = new GrokTurnUsage(null, true);
    usage.observe(response());
    const snapshot = usage.observe({ type: "response.completed", usage: { output_tokens: 10 } });
    expect(snapshot).not.toHaveProperty("cacheHitRatePercent");
    expect(snapshot).not.toHaveProperty("sessionCacheUsage");
    expect(usage.observe(response(20, "later"))).not.toHaveProperty("sessionCacheUsage");
  });

  it("excludes compaction output and starts fresh after compaction", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const usage = new GrokTurnUsage(null, true);
    usage.observe({ type: "agent.text", text: "discarded" });
    usage.observe({ type: "compaction.started" });
    usage.observe({ type: "agent.text", text: "summary" });
    expect(usage.observe(response())).toBeNull();
    usage.observe({ type: "compaction.completed", outcome: "succeeded" });
    clock.mockReturnValue(10000);
    usage.observe({ type: "agent.text", text: "answer" });
    clock.mockReturnValue(11000);
    expect(usage.observe(response())?.outputTokensPerSecond).toBe(20);
  });

  it("resets a discarded retry window when the native stream key changes", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const usage = new GrokTurnUsage(null, true);
    usage.observe({ type: "agent.text", text: "failed attempt", metadata: { streamStartMs: 1 } });
    clock.mockReturnValue(10000);
    usage.observe({ type: "agent.text", text: "retry", metadata: { streamStartMs: 2 } });
    clock.mockReturnValue(11000);
    expect(usage.observe(response())?.outputTokensPerSecond).toBe(20);
  });

  it.each([0, -1])("omits speed for a nonpositive observed duration: %s", (duration) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const usage = new GrokTurnUsage(null, true);
    usage.observe({ type: "agent.text", text: "answer" });
    clock.mockReturnValue(1000 + duration);
    expect(usage.observe(response())).not.toHaveProperty("outputTokensPerSecond");
  });

  it("accepts known-zero output and never uses API duration", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const usage = new GrokTurnUsage(null, true);
    usage.observe({ type: "agent.text", text: "answer" });
    clock.mockReturnValue(2000);
    const event = response(0);
    expect(usage.observe(event)?.outputTokensPerSecond).toBe(0);
    expect(usage.metrics()).not.toHaveProperty("apiOutputTokensPerSecond");
  });
});
