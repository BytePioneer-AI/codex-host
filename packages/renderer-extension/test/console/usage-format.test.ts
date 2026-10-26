import { describe, expect, it } from "vitest";
import {
  axisValue,
  count,
  emptyTotals,
  formatMeasure,
  inputWithoutCache,
  measured,
  tokenCount,
  tokenSummary,
  tokensWithCache,
  tokensWithoutCache,
} from "../../src/console/usage/format.js";

describe("usage token accounting", () => {
  it("includes normalized cache and reasoning only once in the overview total", () => {
    const totals = {
      ...emptyTotals(),
      requests: 1,
      inputTokens: 1_050,
      cachedInputTokens: 900,
      cacheWriteInputTokens: 50,
      cacheKnownInputTokens: 1_050,
      outputTokens: 30,
      reasoningOutputTokens: 20,
    };
    expect(tokensWithCache(totals)).toBe(1_080);
    expect(inputWithoutCache(totals)).toBe(100);
    expect(
      inputWithoutCache(totals) +
        totals.outputTokens +
        totals.cachedInputTokens +
        totals.cacheWriteInputTokens,
    ).toBe(tokensWithCache(totals));
    expect(tokensWithoutCache(totals)).toBe(130);
    // Changing the overview does not change the trend and ranking measure.
    expect(measured(totals, "tokens")).toBe(130);
  });

  it("retains input with unknown cache breakdown without inventing cache tokens", () => {
    const totals = { ...emptyTotals(), requests: 1, inputTokens: 1_000, outputTokens: 30 };
    expect(tokensWithCache(totals)).toBe(1_030);
    expect(inputWithoutCache(totals)).toBe(1_000);
    expect(tokensWithCache(emptyTotals())).toBe(0);
  });
});

describe("Chinese usage numbers", () => {
  it.each([
    [0, "0"],
    [999, "999"],
    [1_000, "1,000"],
    [9_999, "9,999"],
    [10_000, "1 万"],
    [12_345, "1.23 万"],
    [3_000_000, "300 万"],
    [99_999_999, "1 亿"],
    [100_000_000, "1 亿"],
    [116_222_990, "1.16 亿"],
    [1_000_000_000, "10 亿"],
    [-116_222_990, "-1.16 亿"],
  ])("formats %s as %s", (value, expected) => {
    expect(count(value, "zh-CN")).toBe(expected);
    expect(count(value, "zh-TW")).toBe(expected);
  });

  it("keeps the complete total and adds a secondary approximation only for large values", () => {
    expect(tokenSummary(116_222_990, "zh-CN")).toEqual({
      value: "116,222,990",
      approximation: "≈ 1.16 亿",
    });
    expect(tokenSummary(10_000, "zh-CN")).toEqual({ value: "10,000", approximation: "≈ 1 万" });
    expect(tokenSummary(9_999, "zh-CN")).toEqual({ value: "9,999", approximation: null });
    expect(tokenSummary(0, "zh-CN")).toEqual({ value: "0", approximation: null });
  });

  it("uses the same Chinese units in tables, axes and tooltips without changing USD", () => {
    expect(tokenCount(emptyTotals(), 116_222_990, "zh-CN")).toBe("1.16 亿");
    expect(axisValue("tokens", 120_000_000, "zh-CN")).toBe("1.2 亿");
    expect(formatMeasure("tokens", 116_222_990, "zh-CN")).toBe("1.16 亿");
    expect(axisValue("cost", 12_000, "zh-CN")).toBe("$12K");
    expect(formatMeasure("cost", 12_000, "zh-CN")).toBe("$12,000.00");
    expect(tokenCount({ ...emptyTotals(), requests: 1, unmeteredRequests: 1 }, 0, "zh-CN")).toBe(
      "—",
    );
  });

  it("preserves English compact notation", () => {
    expect(count(1_000)).toBe("1K");
    expect(count(3_000_000, "en-US")).toBe("3M");
    expect(count(1_000_000_000, "en")).toBe("1B");
    expect(tokenSummary(116_222_990, "en")).toEqual({ value: "116.2M", approximation: null });
    expect(axisValue("tokens", 3_000_000, "en")).toBe("3M");
    expect(formatMeasure("tokens", 3_000_000, "en")).toBe("3M");
  });
});
