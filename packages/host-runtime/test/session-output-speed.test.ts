import { describe, expect, it } from "vitest";
import { UsageMeter } from "@codexhost/session-runtime/usage-metering";

const prices = { find: () => null };
function timing(
  requestId: string,
  outputTokens: number,
  startedAtMs: number,
  completedAtMs: number,
) {
  return { requestId, outputTokens, startedAtMs, completedAtMs };
}

describe("Session average output speed", () => {
  it("weights request output by generation duration across Turns, excluding gaps", () => {
    const meter = new UsageMeter();
    meter.turnStarted("a", 0);
    meter.recordOutputTiming(timing("one", 100, 10_000, 11_000), "a");
    meter.turnCompleted("a");
    meter.turnStarted("b", 1_000_000);
    meter.recordOutputTiming(timing("two", 300, 1_100_000, 1_109_000), "b");
    expect(meter.derive(null, prices)).toMatchObject({
      outputTokensPerSecond: 300 / 9,
      sessionOutputTokensPerSecond: 40,
    });
    meter.turnCompleted("b");
    meter.resetTurnTiming();
    expect(meter.derive(null, prices)?.sessionOutputTokensPerSecond).toBe(40);
  });

  it("does not infer duration from aggregate TPS or count untimed output", () => {
    const meter = new UsageMeter();
    meter.recordRequest({ requestId: "untimed", inputTokens: 1, outputTokens: 1_000_000 }, null);
    expect(meter.derive({ outputTokensPerSecond: 608 }, prices)).not.toHaveProperty(
      "sessionOutputTokensPerSecond",
    );
    meter.turnStarted("t", 0);
    meter.recordRequest({ ...timing("timed", 100, 1000, 2000), inputTokens: 1 }, "t");
    expect(meter.derive(null, prices)?.sessionOutputTokensPerSecond).toBe(100);
    expect(meter.recordOutputTiming(timing("timed", 100, 1000, 2000), "t")).toBe(false);
    expect(meter.derive(null, prices)?.sessionOutputTokensPerSecond).toBe(100);
  });

  it("uses verified historical intervals without fabricating live Turn speed", () => {
    const meter = new UsageMeter();
    const request = { ...timing("history", 200, 1000, 5000), inputTokens: 1, historical: true };
    meter.replaceHistory([request], true);
    expect(meter.derive(null, prices)).toEqual({ sessionOutputTokensPerSecond: 50 });
    meter.replaceHistory([request], true);
    expect(meter.derive(null, prices)?.sessionOutputTokensPerSecond).toBe(50);
    meter.replaceHistory([], true);
    expect(meter.derive(null, prices)).not.toHaveProperty("sessionOutputTokensPerSecond");
  });

  it("restores completed facts, deduplicates replay and continues with new requests", () => {
    const meter = new UsageMeter();
    meter.turnStarted("a", 0);
    meter.recordOutputTiming(timing("one", 100, 1000, 2000), "a");
    const saved = meter.measurementSnapshot();
    const restored = new UsageMeter();
    restored.restoreOutputTimings(saved.outputTimings ?? []);
    restored.restoreOutputTimings(saved.outputTimings ?? []);
    expect(restored.derive(null, prices)).toEqual({ sessionOutputTokensPerSecond: 100 });
    restored.turnStarted("b", 10_000);
    restored.recordOutputTiming(timing("two", 300, 11_000, 20_000), "b");
    expect(restored.derive(null, prices)?.sessionOutputTokensPerSecond).toBe(40);
    expect(restored.measurementSnapshot().outputTimings).toHaveLength(2);
    restored.turnCompleted("b");
    restored.retainMeasurements(new Set(["a"]));
    expect(restored.derive(null, prices)?.sessionOutputTokensPerSecond).toBe(100);
    restored.retainMeasurements(new Set());
    expect(restored.derive(null, prices)).not.toHaveProperty("sessionOutputTokensPerSecond");
  });

  it("preserves valid zero measurements and rejects invalid timing", () => {
    const meter = new UsageMeter();
    meter.turnStarted("a", 0);
    expect(meter.recordOutputTiming(timing("invalid", 10, 1000, 1000), "a")).toBe(false);
    expect(meter.derive(null, prices)?.sessionOutputTokensPerSecond).toBeUndefined();
    meter.turnStarted("b", 2000);
    expect(meter.recordOutputTiming(timing("zero", 0, 3000, 4000), "b")).toBe(true);
    expect(meter.derive(null, prices)?.sessionOutputTokensPerSecond).toBe(0);
    expect(new UsageMeter().derive({ sessionOutputTokensPerSecond: 999 }, prices)).toBeNull();
  });
});
