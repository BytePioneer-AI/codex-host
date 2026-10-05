import { afterEach, describe, expect, it, vi } from "vitest";
import { GrokGenerationTiming } from "../src/grok-usage.js";
import type { GrokTransportEvent } from "../src/acp-transport.js";

const metadata = (streamStartMs = 1) => ({ streamStartMs, promptId: "prompt" });
const text = (stream = 1): GrokTransportEvent => ({
  type: "agent.text",
  text: "answer",
  metadata: metadata(stream),
});
const thought = (stream = 1): GrokTransportEvent => ({
  type: "agent.thought",
  text: "thinking",
  metadata: metadata(stream),
});
const tool = (stream = 1, callId = "tool"): GrokTransportEvent => ({
  type: "tool.call",
  callId,
  title: "Fixture",
  metadata: metadata(stream),
});
const usage = { inputTokens: 100, outputTokens: 60, reasoningTokens: 10, modelCalls: 1 };

afterEach(() => vi.restoreAllMocks());

describe("Grok live generation timing", () => {
  it("starts at received thought, not streamStartMs, text, or API request start", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(10000);
    const timing = new GrokGenerationTiming();
    timing.observe(thought());
    clock.mockReturnValue(11000);
    timing.observe(text());
    clock.mockReturnValue(12000);
    timing.endStream();
    expect(timing.rate({ ...usage, apiDurationMs: 999999 }, "prompt")).toBe(30);
  });

  it("weights all streams and excludes tool/permission waits and next-request prefill", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const timing = new GrokGenerationTiming();
    timing.observe(thought());
    clock.mockReturnValue(3000);
    timing.observe(tool());
    clock.mockReturnValue(5000);
    timing.observe(tool(1, "parallel"));
    timing.endStream(); // Permission requested after the first tool call; no double counting.
    clock.mockReturnValue(15000);
    timing.observe({ type: "tool.update", callId: "tool", status: "completed" });
    clock.mockReturnValue(20000);
    timing.observe(thought(2));
    clock.mockReturnValue(20500);
    timing.observe(tool(1, "late-parallel"));
    timing.observe(text(2));
    clock.mockReturnValue(21000);
    timing.endStream();
    expect(timing.rate({ ...usage, modelCalls: 2 }, "prompt")).toBe(20);
  });

  it("can end at permission before waiting, without an extra tool notification", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const timing = new GrokGenerationTiming();
    timing.observe(text());
    clock.mockReturnValue(2000);
    timing.endStream();
    clock.mockReturnValue(30000);
    timing.endStream();
    expect(timing.rate({ ...usage, reasoningTokens: 0 }, "prompt")).toBe(60);
  });

  it("uses a live terminal once, ignoring background task terminals and settlement delay", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const timing = new GrokGenerationTiming();
    timing.observe(thought());
    clock.mockReturnValue(2000);
    timing.observe({
      type: "turn.completed",
      nativeTurnKey: "task-completed-1",
      stopReason: "end_turn",
    });
    clock.mockReturnValue(3000);
    timing.observe({ type: "turn.completed", nativeTurnKey: "prompt", stopReason: "end_turn" });
    clock.mockReturnValue(50000);
    timing.endStream();
    expect(timing.rate(usage, "prompt")).toBe(30);
  });

  it.each([
    ["incomplete usage", { ...usage, usageIsIncomplete: true }],
    ["invalid completeness flag", { ...usage, usageIsIncomplete: "unknown" }],
    ["missing call count", { ...usage, modelCalls: undefined }],
    ["missing stream", { ...usage, modelCalls: 2 }],
    ["missing output", { ...usage, outputTokens: undefined }],
    ["zero output", { ...usage, outputTokens: 0 }],
    ["invalid output", { ...usage, outputTokens: -1 }],
  ])("omits speed for %s", (_name, value) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const timing = new GrokGenerationTiming();
    timing.observe(thought());
    clock.mockReturnValue(3000);
    timing.endStream();
    expect(timing.rate(value, "prompt")).toBeUndefined();
  });

  it.each([0, -1000])("rejects a nonpositive duration (%s)", (elapsed) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const timing = new GrokGenerationTiming();
    timing.observe(thought());
    clock.mockReturnValue(1000 + elapsed);
    timing.endStream();
    expect(timing.rate(usage, "prompt")).toBeUndefined();
  });

  it("omits missing endings, foreign turn usage and entirely unobserved turns", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const timing = new GrokGenerationTiming();
    expect(timing.rate(usage, "prompt")).toBeUndefined();
    timing.observe(thought());
    expect(timing.rate(usage, "prompt")).toBeUndefined();
    clock.mockReturnValue(3000);
    timing.endStream();
    expect(timing.rate(usage, "other-prompt")).toBeUndefined();
  });

  it.each([
    { type: "agent.text", text: "no metadata" },
    { ...text(), metadata: { promptId: "prompt", streamStartMs: NaN } },
    { ...text(), metadata: { streamStartMs: 1 } },
    { ...text(2), metadata: { streamStartMs: 2, promptId: "other-prompt" } },
    { type: "compaction.started" },
    tool(2), // No observed first output for this tool-only request.
    thought(2), // Retry/new stream without the previous stream's end.
  ] satisfies GrokTransportEvent[])(
    "omits incomplete/ambiguous stream observations: $type",
    (event) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
      const timing = new GrokGenerationTiming();
      timing.observe(thought());
      clock.mockReturnValue(2000);
      timing.observe(event);
      clock.mockReturnValue(3000);
      timing.endStream();
      expect(timing.rate(usage, "prompt")).toBeUndefined();
    },
  );

  it("does not include hidden reasoning in a text-only timing window", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const timing = new GrokGenerationTiming();
    timing.observe(text());
    clock.mockReturnValue(3000);
    timing.endStream();
    expect(timing.rate(usage, "prompt")).toBeUndefined();
    expect(timing.rate({ ...usage, reasoningTokens: 0 }, "prompt")).toBe(30);
  });

  it("requires observable reasoning in every request when only aggregate reasoning is known", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const timing = new GrokGenerationTiming();
    timing.observe(thought());
    clock.mockReturnValue(2000);
    timing.observe(tool());
    clock.mockReturnValue(5000);
    timing.observe(text(2));
    clock.mockReturnValue(6000);
    timing.endStream();
    expect(timing.rate({ ...usage, modelCalls: 2 }, "prompt")).toBeUndefined();
  });
});
