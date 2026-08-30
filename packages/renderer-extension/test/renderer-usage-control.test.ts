import { describe, expect, it } from "vitest";

import {
  formatRendererPlanReset,
  formatRendererPlanWindow,
  formatRendererNativeContextUsageDetails,
  rendererUsageHasDisplayData,
  clearRendererNativeContextUsage,
  syncRendererNativeContextUsage,
} from "../src/renderer-usage-control.js";

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
  it("formats detailed fields for the native Context tooltip", () => {
    expect(
      formatRendererNativeContextUsageDetails({
        cacheHitRatePercent: 0,
        cachedInputTokens: 12_345,
        reasoningOutputTokens: 18_600,
        totalTokens: 17_087,
        inputTokens: 17_028,
        outputTokens: 59,
        totalCostUsd: 0.343,
      }),
    ).toBe(
      "Latest cache hit: CH 0%\n" +
        "Cache read: 12.3k\n" +
        "Reasoning: 18.6k\n" +
        "Total tokens: 17.1k\n" +
        "Input / output: 17k / 59\n" +
        "Session cost: $0.343",
    );
  });

  it("does not mutate the native Context accessible label", () => {
    const attributes = new Map<string, string>();
    const element = {
      getAttribute: (name: string) => attributes.get(name) ?? null,
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      removeAttribute: (name: string) => attributes.delete(name),
    } as unknown as HTMLElement;
    element.setAttribute("aria-label", "Context usage: 4% used");

    syncRendererNativeContextUsage(element, {
      cacheHitRatePercent: 96.5,
      inputTokens: 1_000,
      outputTokens: 20,
    });
    expect(element.getAttribute("aria-label")).toBe("Context usage: 4% used");

    clearRendererNativeContextUsage(element);
    expect(element.getAttribute("aria-label")).toBe("Context usage: 4% used");
  });

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
