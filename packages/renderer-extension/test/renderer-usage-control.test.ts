import { describe, expect, it } from "vitest";

import {
  formatRendererContextSummary,
  formatRendererCredits,
  formatRendererPlanReset,
  formatRendererPlanWindow,
  formatRendererTokenCount,
  formatRendererTokenRate,
  renderRendererUsageControl,
  rendererUsageHasDisplayData,
  rendererUsageMessages,
} from "../src/renderer-usage-control.js";

describe("Renderer Usage localization", () => {
  it("shows credit-only and context-only data without dollar conversion", () => {
    expect(rendererUsageHasDisplayData({ totalCredits: 0.05 })).toBe(true);
    expect(rendererUsageHasDisplayData({ contextUsagePercent: 9.5 })).toBe(true);
    expect(formatRendererCredits(0.058778444510779446)).toBe("0.059 credits");
    expect(formatRendererCredits(0.00001)).toBe("<0.001 credits");
    expect(formatRendererCredits(0)).toBe("0 credits");
    expect(rendererUsageMessages("zh-CN").recordedCredits).toBe("已记录消耗");
  });
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

describe("Renderer Usage context-summary formatting", () => {
  it("shows the used percentage and the context window", () => {
    expect(formatRendererContextSummary(15_000, 934_500)).toBe("1.6% / 934.5k");
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
  it("does not show Usage for a plan-only snapshot", () => {
    expect(rendererUsageHasDisplayData({ planFiveHourUsedPercent: 45 })).toBe(false);
    expect(rendererUsageHasDisplayData({ planSevenDayUsedPercent: 12 })).toBe(false);
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

describe("Renderer Usage chip formatting", () => {
  it("formats context summary and tokens instead of static usage label", () => {
    const createMockElement = () => ({
      style: {},
      setAttribute: () => {},
      append: () => {},
      replaceChildren: () => {},
      textContent: "",
      title: "",
    });
    const fakeDoc = {
      createElement: () => createMockElement(),
      head: { appendChild: () => {} },
      querySelector: () => null,
    };
    const previousDoc = (globalThis as unknown as { document?: unknown }).document;
    (globalThis as unknown as { document: unknown }).document = fakeDoc;

    try {
      const control = {
        root: createMockElement(),
        trigger: createMockElement(),
        label: { textContent: "" },
        popover: createMockElement(),
        locale: "zh-CN",
      } as unknown as Parameters<typeof renderRendererUsageControl>[0];

      // 1. Used + window tokens formatted into percentage and window
      renderRendererUsageControl(
        control,
        { contextUsedTokens: 10_000, contextWindowTokens: 200_000 },
        "zh-CN",
      );
      expect(control.label.textContent).toBe("5% / 200k");

      // 2. Context usage percent alone
      renderRendererUsageControl(control, { contextUsagePercent: 12.5 }, "zh-CN");
      expect(control.label.textContent).toBe("12.5%");

      // 3. Token usage alone
      renderRendererUsageControl(control, { totalTokens: 50_000 }, "zh-CN");
      expect(control.label.textContent).toBe("50k Token");
    } finally {
      (globalThis as unknown as { document?: unknown }).document = previousDoc;
    }
  });
});
