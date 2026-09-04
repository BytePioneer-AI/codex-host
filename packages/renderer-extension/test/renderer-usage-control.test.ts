import { describe, expect, it } from "vitest";

import {
  formatRendererPlanReset,
  formatRendererPlanWindow,
  formatRendererTokenCount,
  formatRendererTokenRate,
  rendererUsageHasDisplayData,
  rendererUsageMessages,
} from "../src/renderer-usage-control.js";

describe("Renderer Usage localization", () => {
  it("uses Chinese copy only for the Chinese settings locale", () => {
    expect(rendererUsageMessages("zh-CN")).toMatchObject({
      usage: "用量",
      context: "上下文",
      latestCacheHit: "最近缓存命中率",
      inputOutput: "输入 / 输出",
      sessionCostEstimate: "会话费用估算",
    });
    expect(formatRendererTokenRate(42.5, "zh-CN")).toBe("42.5 Token/秒");
    expect(rendererUsageMessages("en")).toMatchObject({
      usage: "Usage",
      context: "Context",
      latestCacheHit: "Latest cache hit",
      inputOutput: "Input / output",
      sessionCostEstimate: "Session cost estimate",
    });
    expect(formatRendererTokenRate(42.5, "en")).toBe("42.5 tok/s");
  });
});

describe("Renderer Usage token-count formatting", () => {
  it("switches units at the exact k, M, and B thresholds", () => {
    expect(formatRendererTokenCount(999)).toBe("999");
    expect(formatRendererTokenCount(1_000)).toBe("1k");
    expect(formatRendererTokenCount(999_999)).toBe("1000k");
    expect(formatRendererTokenCount(1_000_000)).toBe("1M");
    expect(formatRendererTokenCount(162_108_400)).toBe("162.1M");
    expect(formatRendererTokenCount(999_999_999)).toBe("1000M");
    expect(formatRendererTokenCount(1_000_000_000)).toBe("1B");
    expect(formatRendererTokenCount(-1_250_000_000)).toBe("-1.3B");
  });
});

describe("Renderer Usage plan-window formatting", () => {
  it("formats a used percent with no reset", () => {
    expect(formatRendererPlanWindow(45)).toBe("45%");
  });

  it("formats a used percent with a localized reset time", () => {
    const formatted = formatRendererPlanWindow(45, 1_756_130_400);
    expect(formatted.startsWith("45%")).toBe(true);
    expect(formatted).toContain("·");
  });

  it("formats an invalid reset timestamp as an empty string", () => {
    expect(formatRendererPlanReset(Number.NaN)).toBe("");
  });
});

describe("Renderer Usage Claude plan windows", () => {
  it("keeps a plan-only snapshot eligible for the Usage popover", () => {
    expect(rendererUsageHasDisplayData({ planFiveHourUsedPercent: 45 })).toBe(true);
  });
});

describe("Renderer Usage native Codex snapshots", () => {
  it("keeps token-only native snapshots eligible for the left Usage popover", () => {
    expect(
      rendererUsageHasDisplayData({
        totalTokens: 12_345,
        inputTokens: 10_000,
        outputTokens: 2_345,
      }),
    ).toBe(true);
    expect(rendererUsageHasDisplayData(null)).toBe(false);
  });
});
