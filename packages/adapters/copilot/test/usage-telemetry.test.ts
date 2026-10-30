import { describe, expect, it } from "vitest";
import { CopilotUsageTelemetry } from "../src/usage-telemetry.js";
type Receipt = Parameters<CopilotUsageTelemetry["receive"]>[0];
const receipt = (overrides: Partial<Receipt> = {}): Receipt => ({
  model: "native-model",
  apiCallId: "call-one",
  inputTokens: 100,
  cacheReadTokens: 80,
  cacheWriteTokens: 15,
  outputTokens: 100,
  reasoningTokens: 25,
  duration: 2000,
  outputTtftMs: 1000,
  ...overrides,
});

describe("Copilot native output rates and recent cache", () => {
  it.each([true, false])(
    "joins root messages and receipts in either order (usage first: %s)",
    (usageFirst) => {
      const usage = new CopilotUsageTelemetry();
      usage.begin("turn-one");
      if (usageFirst) {
        expect(usage.receive(receipt())).toBe(false);
        usage.associate("call-one", "turn-one");
      } else {
        expect(usage.associate("call-one", "turn-one")).toBe(false);
        usage.receive(receipt());
      }
      expect(usage.snapshot()).toEqual({
        outputTokensPerSecond: 100,
        apiOutputTokensPerSecond: 50,
        cacheHitRatePercent: 80,
      });
    },
  );
  it("sums per-request generation intervals within a Turn without adding reasoning twice or tool waits", () => {
    const usage = new CopilotUsageTelemetry();
    usage.begin("one");
    usage.associate("call-one", "one");
    usage.receive(receipt());
    usage.associate("call-two", "one");
    usage.receive(
      receipt({ apiCallId: "call-two", outputTokens: 50, duration: 3000, outputTtftMs: 1000 }),
    );
    expect(usage.snapshot()).toEqual({
      outputTokensPerSecond: 50,
      apiOutputTokensPerSecond: 30,
      cacheHitRatePercent: 80,
    });
    expect(usage.receive(receipt())).toBe(false);
    expect(usage.snapshot().outputTokensPerSecond).toBe(50);
  });
  it("retains recent valid measurements but isolates old receipts from the next Turn", () => {
    const usage = new CopilotUsageTelemetry();
    usage.begin("one");
    usage.associate("call-one", "one");
    usage.receive(receipt());
    usage.begin("two");
    expect(usage.snapshot().outputTokensPerSecond).toBe(100);
    expect(usage.receive(receipt({ apiCallId: "old-call" }))).toBe(false);
    expect(usage.associate("old-call", "one")).toBe(false);
    usage.associate("new-call", "two");
    usage.receive(
      receipt({ apiCallId: "new-call", outputTokens: 20, duration: 5000, outputTtftMs: 4000 }),
    );
    expect(usage.snapshot().outputTokensPerSecond).toBe(20);
  });
  it("shows API throughput when first-output timing is unavailable and preserves known-zero output", () => {
    const usage = new CopilotUsageTelemetry();
    usage.begin("one");
    usage.associate("call-one", "one");
    const missingFirstOutput = receipt();
    delete missingFirstOutput.outputTtftMs;
    usage.receive(missingFirstOutput);
    expect(usage.snapshot()).toEqual({ apiOutputTokensPerSecond: 50, cacheHitRatePercent: 80 });
    usage.begin("two");
    usage.associate("zero", "two");
    usage.receive(receipt({ apiCallId: "zero", outputTokens: 0 }));
    expect(usage.snapshot()).toEqual({
      outputTokensPerSecond: 0,
      apiOutputTokensPerSecond: 0,
      cacheHitRatePercent: 80,
    });
  });
  it("does not present a partial Turn's rate when a known call is missing timing", () => {
    const usage = new CopilotUsageTelemetry();
    usage.begin("one");
    usage.associate("call-one", "one");
    const missingDuration = receipt();
    delete missingDuration.duration;
    usage.receive(missingDuration);
    usage.associate("second", "one");
    usage.receive(receipt({ apiCallId: "second" }));
    expect(usage.snapshot().outputTokensPerSecond).toBeUndefined();
    expect(usage.snapshot().apiOutputTokensPerSecond).toBeUndefined();
  });
  it("ignores subagent and uncorrelated receipts", () => {
    const usage = new CopilotUsageTelemetry();
    usage.begin("one");
    usage.associate("call-one", "one");
    expect(usage.receive(receipt({ parentToolCallId: "child" }))).toBe(false);
    const missingIdentity = receipt();
    delete missingIdentity.apiCallId;
    expect(usage.receive(missingIdentity)).toBe(false);
    expect(usage.snapshot()).toEqual({});
  });
  it("does not report a full Turn rate after a message lacks request attribution", () => {
    const usage = new CopilotUsageTelemetry();
    usage.begin("one");
    usage.associate(undefined, "one");
    usage.associate("call-one", "one");
    usage.receive(receipt());
    expect(usage.snapshot()).toEqual({ cacheHitRatePercent: 80 });
  });
});
