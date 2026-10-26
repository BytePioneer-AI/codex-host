import { describe, expect, it } from "vitest";

import { ModelPriceLookup } from "../src/model-prices.js";
import { bundledModelPrices } from "../src/model-prices.generated.js";
import { UsageMeter } from "../src/usage-metering.js";

const prices = new ModelPriceLookup({
  fetchedAtMs: 0,
  providers: {
    anthropic: { sonnet: [3, 15, 0.3, 3.75] },
    openai: { "gpt-mini": [1, 4, 0.1] },
  },
});

function request(id: string, overrides: Record<string, unknown> = {}) {
  return {
    requestId: id,
    model: "sonnet",
    inputTokens: 1_000_000,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 100_000,
    ...overrides,
  };
}

function completeMeter(...requests: unknown[]) {
  const meter = new UsageMeter();
  for (const value of requests) meter.recordRequest(value, null);
  meter.recordHistory(true);
  return meter;
}

describe("UsageMeter cost", () => {
  it("derives native session cache average without taking over fees or TPS", () => {
    const meter = new UsageMeter();
    expect(
      meter.derive(
        {
          totalCostUsd: 0.123,
          outputTokensPerSecond: 25,
          cacheHitRatePercent: 80,
          sessionCacheUsage: { inputTokens: 300, cachedInputTokens: 120 },
        },
        prices,
      ),
    ).toEqual({
      totalCostUsd: 0.123,
      costSource: "native",
      outputTokensPerSecond: 25,
      cacheHitRatePercent: 80,
      sessionCacheHitRatePercent: 40,
    });
    expect(meter.metered).toBe(false);
    expect(
      meter.derive({ sessionCacheUsage: { inputTokens: 0, cachedInputTokens: 0 } }, prices),
    ).toBeNull();
    expect(meter.derive({ inputTokens: 300, cachedInputTokens: 120 }, prices)).not.toHaveProperty(
      "sessionCacheHitRatePercent",
    );
    expect(meter.derive({ totalCostUsd: 0.123 }, prices)).not.toHaveProperty(
      "sessionCacheHitRatePercent",
    );
  });

  it("uses the complete request ledger rather than native cache facts in metered mode", () => {
    const meter = completeMeter(request("one", { cachedInputTokens: 250_000 }));
    expect(
      meter.derive({ sessionCacheUsage: { inputTokens: 100, cachedInputTokens: 100 } }, prices)
        ?.sessionCacheHitRatePercent,
    ).toBe(25);
    meter.recordHistory(false);
    expect(
      meter.derive({ sessionCacheUsage: { inputTokens: 100, cachedInputTokens: 100 } }, prices),
    ).toBeNull();
  });
  it("prices every request by its own model and cache category", () => {
    const meter = completeMeter(
      request("a", { cachedInputTokens: 600_000, cacheWriteInputTokens: 200_000 }),
      request("b", { model: "gpt-mini", outputTokens: 0, cachedInputTokens: 500_000 }),
    );
    const usage = meter.derive({ inputTokens: 7 }, prices);
    // a: 0.2M×3 + 0.6M×0.3 + 0.2M×3.75 + 0.1M×15 = 0.6 + 0.18 + 0.75 + 1.5
    // b: 0.5M×1 + 0.5M×0.1
    expect(usage?.totalCostUsd).toBeCloseTo(3.03 + 0.55, 10);
    expect(usage?.costSource).toBe("publicPrice");
    expect(usage?.inputTokens).toBe(7);
  });

  it("estimates the ZCode GLM sample using official prices rather than another provider's plan", () => {
    const meter = completeMeter(
      request("glm-sample", {
        model: "GLM-5.3-Flash",
        inputTokens: 18_761,
        cachedInputTokens: 1_536,
        outputTokens: 67,
      }),
    );
    const usage = meter.derive(null, new ModelPriceLookup(bundledModelPrices));
    expect(usage?.costSource).toBe("publicPrice");
    expect(usage?.totalCostUsd).toBeCloseTo(0.00266333, 10);
    expect(usage?.totalCostUsd?.toFixed(3)).toBe("0.003");
  });

  it("counts a request once across history replay and live delivery", () => {
    const meter = completeMeter(request("a", { historical: true }));
    expect(meter.recordRequest(request("a"), null)).toBe(false);
    expect(meter.derive(null, prices)?.totalCostUsd).toBeCloseTo(4.5, 10);
  });

  it.each([
    ["missing model", request("x", { model: undefined })],
    ["unknown cache", request("x", { cachedInputTokens: undefined })],
  ])("omits the whole cost for %s", (_label, value) => {
    const usage = completeMeter(request("a"), value).derive({ outputTokens: 1 }, prices);
    expect(usage?.totalCostUsd).toBeUndefined();
    expect(usage?.costSource).toBeUndefined();
  });

  it("leaves unpriced Models out of a lower-bound cost and names them", () => {
    const usage = completeMeter(
      request("a"),
      request("x", { model: "auto" }),
      request("y", { model: "gpt-mini", cacheWriteInputTokens: 10 }),
      request("z", { model: "auto" }),
    ).derive({ outputTokens: 1 }, prices);
    expect(usage?.totalCostUsd).toBeCloseTo(4.5, 10);
    expect(usage?.costSource).toBe("publicPrice");
    expect(usage?.unpricedModels).toEqual(["auto", "gpt-mini"]);
  });

  it("publishes no cost when no request has a price", () => {
    const usage = completeMeter(request("x", { model: "auto" })).derive(
      { outputTokens: 1 },
      prices,
    );
    expect(usage?.totalCostUsd).toBeUndefined();
    expect(usage?.unpricedModels).toBeUndefined();
  });

  it("prices one-hour cache writes at twice the input price, as Claude Code does", () => {
    const usage = completeMeter(
      request("a", {
        inputTokens: 1_000_000,
        cacheWriteInputTokens: 1_000_000,
        cacheWrite1hInputTokens: 600_000,
        outputTokens: 0,
      }),
    ).derive(null, prices);
    // 0.4M five-minute writes at 3.75 + 0.6M one-hour writes at 2 × 3.
    expect(usage?.totalCostUsd).toBeCloseTo(1.5 + 3.6, 10);
  });

  it("recomputes cost against the current price table", () => {
    const meter = completeMeter(request("a"));
    const cheaper = new ModelPriceLookup({
      fetchedAtMs: 1,
      providers: { anthropic: { sonnet: [1, 5, 0.1, 1.25] } },
    });
    expect(meter.derive(null, prices)?.totalCostUsd).toBeCloseTo(4.5, 10);
    expect(meter.derive(null, cheaper)?.totalCostUsd).toBeCloseTo(1.5, 10);
  });
});

describe("UsageMeter completeness", () => {
  it("publishes session metrics only after complete history", () => {
    const meter = new UsageMeter();
    meter.recordRequest(request("a", { cachedInputTokens: 250_000 }), null);
    expect(meter.derive({ totalCostUsd: 9 }, prices)).toEqual({
      totalCostUsd: 9,
      costSource: "native",
    });
    meter.recordHistory(true);
    expect(meter.derive({ totalCostUsd: 9 }, prices)).toMatchObject({
      costSource: "publicPrice",
      sessionCacheHitRatePercent: 25,
    });
    meter.recordHistory(false);
    expect(meter.derive({ totalCostUsd: 9, outputTokens: 3 }, prices)).toEqual({
      outputTokens: 3,
    });
  });

  it("suppresses native cost once integrated, even with incomplete history", () => {
    const meter = new UsageMeter();
    meter.recordHistory(false);
    expect(meter.derive({ totalCostUsd: 2 }, prices)).toBeNull();
  });

  it("treats an invalid record as a gap", () => {
    const meter = completeMeter(request("a"));
    meter.recordRequest({ requestId: "bad", inputTokens: -1, outputTokens: 0 }, null);
    expect(meter.derive({ outputTokens: 1 }, prices)).toEqual({ outputTokens: 1 });
  });

  it("omits the session cache rate when any record has unknown cache reads", () => {
    const usage = completeMeter(
      request("a", { cachedInputTokens: 10 }),
      request("b", { cachedInputTokens: undefined }),
    ).derive({ outputTokens: 1 }, prices);
    expect(usage?.sessionCacheHitRatePercent).toBeUndefined();
  });

  it("strips Host-only fields an Adapter tried to publish", () => {
    const usage = new UsageMeter().derive(
      { outputTokens: 1, sessionCacheHitRatePercent: 50, timeToFirstOutputMs: 3 },
      prices,
    );
    expect(usage).toEqual({ outputTokens: 1 });
  });
});

describe("UsageMeter timing", () => {
  it("measures time to first output and per-request output speed", () => {
    const meter = completeMeter();
    meter.turnStarted("turn-1", 1_000);
    expect(meter.outputObserved("turn-1", 1_800)).toBe(true);
    expect(meter.outputObserved("turn-1", 2_000)).toBe(false);
    meter.recordRequest(
      request("a", { outputTokens: 100, startedAtMs: 10_000, completedAtMs: 12_000 }),
      "turn-1",
    );
    meter.recordRequest(
      request("b", { outputTokens: 50, startedAtMs: 20_000, completedAtMs: 21_000 }),
      "turn-1",
    );
    // Excluded from speed: no timing, zero duration, historical.
    meter.recordRequest(request("c", { outputTokens: 999 }), "turn-1");
    meter.recordRequest(
      request("d", { outputTokens: 999, startedAtMs: 5, completedAtMs: 5 }),
      "turn-1",
    );
    meter.recordRequest(
      request("e", { historical: true, outputTokens: 999, startedAtMs: 1, completedAtMs: 2 }),
      "turn-1",
    );
    meter.turnCompleted("turn-1");
    // Arrives after the Turn ended.
    meter.recordRequest(
      request("f", { outputTokens: 999, startedAtMs: 1, completedAtMs: 2 }),
      null,
    );
    const usage = meter.derive(null, prices);
    expect(usage?.timeToFirstOutputMs).toBe(800);
    expect(usage?.outputTokensPerSecond).toBe(50);
  });

  it("updates speed after every timed request while the Turn runs", () => {
    const meter = completeMeter();
    meter.turnStarted("turn-1", 0);
    meter.recordRequest(
      request("a", { outputTokens: 100, startedAtMs: 0, completedAtMs: 1_000 }),
      "turn-1",
    );
    meter.turnCompleted("turn-1");
    meter.turnStarted("turn-2", 0);
    // Until the new Turn has a timed request, the previous Turn's speed stays.
    expect(meter.derive(null, prices)?.outputTokensPerSecond).toBe(100);
    meter.recordRequest(
      request("b", { outputTokens: 30, startedAtMs: 0, completedAtMs: 1_000 }),
      "turn-2",
    );
    expect(meter.derive(null, prices)?.outputTokensPerSecond).toBe(30);
    meter.recordRequest(
      request("c", { outputTokens: 90, startedAtMs: 0, completedAtMs: 1_000 }),
      "turn-2",
    );
    expect(meter.derive(null, prices)?.outputTokensPerSecond).toBe(60);
    meter.turnCompleted("turn-2");
    expect(meter.derive(null, prices)?.outputTokensPerSecond).toBe(60);
  });

  it("keeps the last speed for a Turn without timed requests", () => {
    const meter = completeMeter();
    meter.turnStarted("turn-1", 0);
    meter.recordRequest(
      request("a", { outputTokens: 10, startedAtMs: 0, completedAtMs: 1_000 }),
      "turn-1",
    );
    meter.turnCompleted("turn-1");
    meter.turnStarted("turn-2", 0);
    meter.recordRequest(request("b"), "turn-2");
    meter.turnCompleted("turn-2");
    expect(meter.derive(null, prices)?.outputTokensPerSecond).toBe(10);
  });

  it("retains the last valid speed through invalidation and reset, without sharing it across sessions", () => {
    const meter = completeMeter();
    expect(meter.derive(null, prices)?.outputTokensPerSecond).toBeUndefined();
    meter.turnStarted("one", 0);
    meter.recordOutputTiming(
      { requestId: "r", outputTokens: 80, startedAtMs: 0, completedAtMs: 1000 },
      "one",
    );
    // Retention must not depend on whether the UI already read the value.
    meter.invalidateOutputTiming("one");
    expect(meter.derive(null, prices)?.outputTokensPerSecond).toBe(80);
    meter.resetTurnTiming();
    expect(meter.derive(null, prices)?.outputTokensPerSecond).toBe(80);
    meter.turnStarted("two", 2000);
    meter.recordOutputTiming(
      { requestId: "next", outputTokens: 0, startedAtMs: 2000, completedAtMs: 3000 },
      "two",
    );
    expect(meter.derive(null, prices)?.outputTokensPerSecond).toBe(0);
    expect(completeMeter().derive(null, prices)?.outputTokensPerSecond).toBeUndefined();
  });
});
