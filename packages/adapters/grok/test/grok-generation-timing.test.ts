import { afterEach, describe, expect, it, vi } from "vitest";
import { GrokTurnUsage } from "../src/grok-usage.js";
import type { GrokTransportEvent } from "../src/acp-transport.js";

const response = (output = 20, messageId = "one", reasoning = 0): GrokTransportEvent => ({
  type: "response.completed",
  messageId,
  usage: {
    input_tokens: 70,
    cache_read_input_tokens: 20,
    cache_creation_input_tokens: 10,
    output_tokens: output,
    reasoning_tokens: reasoning,
  },
});

afterEach(() => vi.restoreAllMocks());

describe("Grok live response usage", () => {
  it("updates after each request, excluding tool waits and weighting durations", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const usage = new GrokTurnUsage(null, true);
    usage.observe({ type: "agent.thought", text: "thinking" });
    clock.mockReturnValue(2000);
    expect(usage.observe(response(20, "one", 5))).toMatchObject({
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

  it("times tool-only output with explicit zero reasoning from partial native arguments", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const usage = new GrokTurnUsage(null, true);
    usage.observe({ type: "tool.input.delta", text: '{"command":' });
    clock.mockReturnValue(1500);
    usage.observe({ type: "tool.input.delta", text: '"pwd"}' });
    clock.mockReturnValue(2000);
    expect(usage.observe(response())?.outputTokensPerSecond).toBe(20);
  });

  it("subtracts hidden reasoning from text-first timing without changing usage totals", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(21000);
    const usage = new GrokTurnUsage(null, true);
    usage.observe({ type: "agent.text", text: "answer" });
    clock.mockReturnValue(26000);
    usage.observe({ type: "tool.input.delta", text: '{"command":"pwd"}' });
    clock.mockReturnValue(31000);
    const snapshot = usage.observe(response(1200, "hidden", 800));
    expect(snapshot).toMatchObject({
      inputTokens: 100,
      outputTokens: 1200,
      reasoningOutputTokens: 800,
      totalTokens: 1300,
      cachedInputTokens: 20,
      cacheWriteInputTokens: 10,
      cacheHitRatePercent: 20,
      sessionCacheUsage: { inputTokens: 100, cachedInputTokens: 20 },
    });
    expect(snapshot?.outputTokensPerSecond).toBe(40);
    expect(usage.metrics().outputTokensPerSecond).toBe(40);
  });

  it("includes the full observed reasoning interval without subtracting reasoning tokens", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const usage = new GrokTurnUsage(null, true);
    usage.observe({ type: "agent.thought", text: "thinking" });
    clock.mockReturnValue(21000);
    usage.observe({ type: "agent.text", text: "answer" });
    clock.mockReturnValue(31000);
    expect(usage.observe(response(1200, "observed", 800))).toMatchObject({
      outputTokens: 1200,
      reasoningOutputTokens: 800,
      outputTokensPerSecond: 40,
    });
  });

  it("uses the text window from the sanitized Grok 1.0.77 hidden-reasoning trace", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(3583);
    const usage = new GrokTurnUsage(null, true);
    usage.observe({
      type: "agent.text",
      text: "answer",
      metadata: { streamStartMs: 1800 },
    });
    clock.mockReturnValue(8333);
    const snapshot = usage.observe(response(437, "native-hidden", 71));
    expect(snapshot).toMatchObject({ outputTokens: 437, reasoningOutputTokens: 71 });
    expect(snapshot?.outputTokensPerSecond).toBeCloseTo(77.05, 2);
  });

  it.each([false, true])(
    "requires a reasoning observation when its count is absent: %s",
    (thought) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
      const usage = new GrokTurnUsage(null, true);
      if (thought) usage.observe({ type: "agent.thought", text: "thinking" });
      usage.observe({ type: "agent.text", text: "answer" });
      clock.mockReturnValue(2000);
      const snapshot = usage.observe({
        type: "response.completed",
        usage: { input_tokens: 70, output_tokens: 20 },
      });
      expect(snapshot).toMatchObject({ outputTokens: 20 });
      expect(snapshot).not.toHaveProperty("reasoningOutputTokens");
      if (thought) expect(snapshot?.outputTokensPerSecond).toBe(20);
      else expect(snapshot).not.toHaveProperty("outputTokensPerSecond");
    },
  );

  it.each([false, true])(
    "aggregates only trustworthy requests in either order: bad first=%s",
    (badFirst) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
      const usage = new GrokTurnUsage(null, true);
      const good = (id: string, start: number) => {
        clock.mockReturnValue(start);
        usage.observe({ type: "agent.thought", text: "thinking" });
        clock.mockReturnValue(start + 1000);
        return usage.observe(response(20, id, 5));
      };
      const bad = () => {
        clock.mockReturnValue(10000);
        usage.observe({ type: "tool.input.delta", text: '{"command":' });
        clock.mockReturnValue(11000);
        usage.observe({ type: "agent.text", text: "hidden reasoning answer" });
        clock.mockReturnValue(20000);
        return usage.observe(response(1200, "bad", 800));
      };
      if (badFirst) {
        expect(bad()).not.toHaveProperty("outputTokensPerSecond");
        expect(good("good", 21000)?.outputTokensPerSecond).toBe(20);
      } else {
        expect(good("good", 1000)?.outputTokensPerSecond).toBe(20);
        expect(bad()?.outputTokensPerSecond).toBe(20);
      }
      expect(usage.snapshot()).toMatchObject({
        outputTokens: 1220,
        reasoningOutputTokens: 805,
        outputTokensPerSecond: 20,
      });
      clock.mockReturnValue(30000);
      usage.observe({ type: "agent.text", text: "known zero reasoning" });
      clock.mockReturnValue(33000);
      expect(usage.observe(response(100, "next-good", 0))).toMatchObject({
        outputTokens: 1320,
        reasoningOutputTokens: 805,
        outputTokensPerSecond: 30,
      });
    },
  );

  it.each([false, true])("combines full and text-only windows: text first=%s", (textFirst) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const usage = new GrokTurnUsage(null, true);
    const full = () => {
      clock.mockReturnValue(textFirst ? 10000 : 1000);
      usage.observe({ type: "agent.thought", text: "thinking" });
      clock.mockReturnValue(textFirst ? 11000 : 2000);
      return usage.observe(response(20, "full", 5));
    };
    const text = () => {
      clock.mockReturnValue(textFirst ? 1000 : 10000);
      usage.observe({ type: "agent.text", text: "answer" });
      clock.mockReturnValue(textFirst ? 4000 : 13000);
      return usage.observe(response(110, "text", 10));
    };
    if (textFirst) {
      expect(text()?.outputTokensPerSecond).toBeCloseTo(100 / 3);
      full();
    } else {
      expect(full()?.outputTokensPerSecond).toBe(20);
      text();
    }
    expect(usage.snapshot()).toMatchObject({
      outputTokens: 130,
      reasoningOutputTokens: 15,
      outputTokensPerSecond: 30,
    });
  });

  it.each([20, 21])(
    "omits text-window speed when reasoning is at least output: %s",
    (reasoning) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
      const usage = new GrokTurnUsage(null, true);
      usage.observe({ type: "agent.text", text: "answer" });
      clock.mockReturnValue(2000);
      const snapshot = usage.observe(response(20, "all-reasoning", reasoning));
      expect(snapshot).toMatchObject({ outputTokens: 20, reasoningOutputTokens: reasoning });
      expect(snapshot).not.toHaveProperty("outputTokensPerSecond");
    },
  );

  it("does not use a text window after buffered tool arguments with hidden reasoning", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const usage = new GrokTurnUsage(null, true);
    usage.observe({ type: "tool.input.delta", text: '{"command":"pwd"}' });
    clock.mockReturnValue(2000);
    usage.observe({ type: "agent.text", text: "answer" });
    clock.mockReturnValue(3000);
    expect(usage.observe(response(20, "buffered-hidden", 5))).not.toHaveProperty(
      "outputTokensPerSecond",
    );
  });

  it.each(['{"command":"pwd"}', "{}", '"pwd"', "null", "0"])(
    "does not salvage a buffered first tool payload with later output: %s",
    (text) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
      const usage = new GrokTurnUsage(null, true);
      usage.observe({ type: "tool.input.delta", text });
      clock.mockReturnValue(2000);
      usage.observe({ type: "agent.thought", text: "late thought" });
      usage.observe({ type: "agent.text", text: "late text" });
      clock.mockReturnValue(3000);
      const snapshot = usage.observe(response());
      expect(snapshot).toMatchObject({ outputTokens: 20 });
      expect(snapshot).not.toHaveProperty("outputTokensPerSecond");
      clock.mockReturnValue(4000);
      usage.observe({ type: "tool.input.delta", text: '{"command":' });
      clock.mockReturnValue(5000);
      expect(usage.observe(response(100, "streamed"))).toMatchObject({
        outputTokens: 120,
        outputTokensPerSecond: 100,
      });
    },
  );

  it("retains a reasoning start when complete tool arguments arrive later", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const usage = new GrokTurnUsage(null, true);
    usage.observe({ type: "agent.thought", text: "thinking" });
    clock.mockReturnValue(2000);
    usage.observe({ type: "tool.input.delta", text: '{"command":"pwd"}' });
    clock.mockReturnValue(3000);
    expect(usage.observe(response(100, "thought-and-tool", 80))).toMatchObject({
      outputTokens: 100,
      reasoningOutputTokens: 80,
      outputTokensPerSecond: 50,
    });
  });

  it("does not treat assembled tool lifecycle payloads as generation output", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const usage = new GrokTurnUsage(null, true);
    usage.observe({
      type: "tool.call",
      callId: "one",
      title: "shell",
      rawInput: { command: "pwd" },
    });
    usage.observe({ type: "tool.update", callId: "one", rawInput: { command: "pwd" } });
    usage.observe({ type: "tool.input.delta", text: "  " });
    clock.mockReturnValue(2000);
    const snapshot = usage.observe(response());
    expect(snapshot).toMatchObject({ outputTokens: 20 });
    expect(snapshot).not.toHaveProperty("outputTokensPerSecond");
  });

  it("does not infer hidden-reasoning start from a partial tool argument", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const usage = new GrokTurnUsage(null, true);
    usage.observe({ type: "tool.input.delta", text: '{"command":' });
    clock.mockReturnValue(2000);
    const snapshot = usage.observe(response(20, "hidden-tool", 5));
    expect(snapshot).toMatchObject({ outputTokens: 20, reasoningOutputTokens: 5 });
    expect(snapshot).not.toHaveProperty("outputTokensPerSecond");
  });

  it("resets reasoning provenance on retry and compaction boundaries", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const usage = new GrokTurnUsage(null, true);
    usage.observe({ type: "agent.thought", text: "discarded", metadata: { streamStartMs: 1 } });
    clock.mockReturnValue(10000);
    usage.observe({ type: "agent.text", text: "retry", metadata: { streamStartMs: 2 } });
    clock.mockReturnValue(11000);
    expect(usage.observe(response(20, "retry", 5))?.outputTokensPerSecond).toBe(15);
    usage.observe({ type: "agent.thought", text: "discarded by compaction" });
    usage.observe({ type: "compaction.started" });
    usage.observe({ type: "compaction.completed", outcome: "succeeded" });
    clock.mockReturnValue(20000);
    usage.observe({ type: "agent.text", text: "after compaction" });
    clock.mockReturnValue(21000);
    expect(usage.observe(response(20, "compacted", 5))?.outputTokensPerSecond).toBe(15);
    expect(usage.snapshot()).toMatchObject({ outputTokens: 40, reasoningOutputTokens: 10 });
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

  it("keeps completed metrics when an unfinished request is abandoned", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const usage = new GrokTurnUsage(null, true);
    usage.observe({ type: "agent.thought", text: "thinking" });
    clock.mockReturnValue(2000);
    usage.observe(response(20, "complete", 5));
    clock.mockReturnValue(10000);
    usage.observe({ type: "agent.text", text: "cancelled before response completion" });
    clock.mockReturnValue(20000);
    expect(usage.metrics()).toEqual({ outputTokensPerSecond: 20, cacheHitRatePercent: 20 });
    expect(usage.snapshot()).toMatchObject({ outputTokens: 20, reasoningOutputTokens: 5 });
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
    usage.observe({ type: "agent.text", text: "hidden reasoning answer" });
    clock.mockReturnValue(1000 + 2 * duration);
    expect(usage.observe(response(20, "hidden", 5))).not.toHaveProperty("outputTokensPerSecond");
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
