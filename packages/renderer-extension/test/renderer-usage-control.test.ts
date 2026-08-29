import { describe, expect, it } from "vitest";

import {
  formatRendererPlanReset,
  formatRendererCacheHitRate,
  formatRendererCost,
  formatRendererPlanWindow,
  rendererUsageHasDisplayData,
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

describe("Renderer Usage Claude summary", () => {
  it("keeps plan windows out of the collapsed CH and cost summary fields", () => {
    expect(formatRendererCacheHitRate(99)).toBe("CH 99%");
    expect(formatRendererCost(1.373)).toBe("$1.373");
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
