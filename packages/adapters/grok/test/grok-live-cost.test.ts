import { describe, expect, it } from "vitest";
import { sessionCostFromNative } from "../src/grok-usage.js";

describe("Grok native live cost", () => {
  it("adds a fixed history baseline to each cumulative snapshot, including zero", () => {
    expect(sessionCostFromNative({ costUsdTicks: 100000000 }, 0.05)).toBe(0.06);
    expect(sessionCostFromNative({ costUsdTicks: 300000000 }, 0.05)).toBe(0.08);
    expect(sessionCostFromNative({ costUsdTicks: 0 }, 0.05)).toBe(0.05);
    expect(sessionCostFromNative({ costUsdTicks: 0 }, 0)).toBe(0);
    expect(sessionCostFromNative({ costUsdTicks: 1 }, 0.0000000002)).toBe(0.0000000003);
  });

  it.each([
    undefined,
    null,
    {},
    { costUsdTicks: -1 },
    { costUsdTicks: 1.5 },
    { costUsdTicks: "100" },
    { costUsdTicks: Number.NaN },
    { costUsdTicks: Number.POSITIVE_INFINITY },
    { costUsdTicks: Number.MAX_SAFE_INTEGER + 1 },
    { costUsdTicks: 100, costIsPartial: true },
    { costUsdTicks: 100, usageIsIncomplete: true },
    { costUsdTicks: 100, costIsPartial: "false" },
  ])("ignores absent, invalid or incomplete fees: %j", (value) => {
    expect(sessionCostFromNative(value, 0.05)).toBeUndefined();
  });

  it("does not publish an overflowing sum", () => {
    expect(sessionCostFromNative({ costUsdTicks: Number.MAX_SAFE_INTEGER }, 1)).toBeUndefined();
  });
});
