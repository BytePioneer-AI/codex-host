import { describe, expect, it } from "vitest";
import { KiroUsage } from "../src/usage.js";

const charge = {
  kind: "turn_completion",
  requestIds: ["request-2", "request-1"],
  promptTurnSummaries: [{ unit: "credit", usage: 0.058778444510779446 }],
};

describe("Kiro native Usage", () => {
  it("keeps native credits separate from USD and deduplicates replay/history", () => {
    const usage = new KiroUsage();
    expect(usage.snapshot()).toBeNull();
    usage.observe(charge);
    usage.observe(charge);
    usage.load([
      {
        id: "execution-usage",
        payload: {
          ...charge,
          type: "usage_summary",
          executionId: "execution",
          requestIds: ["request-1", "request-2"],
        },
      },
    ]);
    expect(usage.snapshot()).toEqual({ totalCredits: charge.promptTurnSummaries[0]?.usage });
    usage.observe({
      ...charge,
      requestIds: ["next"],
      promptTurnSummaries: [{ unit: "credit", usage: 0.01 }],
    });
    expect(usage.snapshot()?.totalCredits).toBeCloseTo(0.068778444510779446, 12);
    expect(new KiroUsage().snapshot()).toBeNull();
  });

  it("exposes context percent without inventing token/window or cache counters", () => {
    const usage = new KiroUsage();
    usage.observe({
      kind: "context_usage",
      contextUsage: { usagePercentage: 9.594499588012695 },
      breakdown: { yourPrompts: { tokens: 48 }, kiroResponses: { tokens: 77 } },
    });
    expect(usage.snapshot()).toEqual({ contextUsagePercent: 9.594499588012695 });
    usage.context({ contextUsage: { usagePercentage: 102 } });
    expect(usage.snapshot()).toEqual({ contextUsagePercent: 102 });
  });

  it("restores a known cumulative credit total from native records", () => {
    const usage = new KiroUsage();
    const rows = [
      {
        id: "one",
        payload: {
          type: "usage_summary",
          executionId: "one",
          promptTurnSummaries: [{ unit: "credit", usage: 0.02 }],
        },
      },
      {
        id: "two",
        payload: {
          type: "usage_summary",
          executionId: "two",
          promptTurnSummaries: [{ unit: "credit", usage: 0.03 }],
        },
      },
      { id: "end", payload: { type: "turn_end", stopReason: "cancelled" } },
    ];
    usage.load(rows);
    usage.load(rows);
    expect(usage.snapshot()).toEqual({ totalCredits: 0.05 });
  });

  it("ignores missing identity, invalid charges, account quota and invalid context", () => {
    const usage = new KiroUsage();
    for (const value of [-1, NaN, Infinity, "0.1"]) {
      usage.observe({ ...charge, promptTurnSummaries: [{ unit: "credit", usage: value }] });
      usage.context({ usagePercentage: value });
    }
    usage.observe({ ...charge, requestIds: [] });
    usage.observe({ used: 100, limit: 1000 });
    expect(usage.snapshot()).toBeNull();
    usage.observe({ ...charge, promptTurnSummaries: [{ unit: "credit", usage: 0 }] });
    expect(usage.snapshot()).toEqual({ totalCredits: 0 });
  });
});
