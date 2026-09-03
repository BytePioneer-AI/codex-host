import { describe, expect, it, vi } from "vitest";

import {
  clearRendererNativeContextUsage,
  formatRendererNativeContextUsageDetails,
  formatRendererPlanReset,
  formatRendererPlanWindow,
  formatRendererTokenCount,
  formatRendererTokenRate,
  rendererUsageHasDisplayData,
  rendererUsageMessages,
  syncRendererNativeContextUsage,
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
        "Session cost estimate: $0.343",
    );
  });

  it("localizes the native Context tooltip rows for the Chinese settings locale", () => {
    expect(
      formatRendererNativeContextUsageDetails(
        {
          cacheHitRatePercent: 0,
          totalTokens: 17_087,
          outputTokensPerSecond: 42,
          totalCostUsd: 0.343,
        },
        "zh-CN",
      ),
    ).toBe(
      "最近缓存命中率: CH 0%\n" +
        "Token 总数: 17.1k\n" +
        "输出速度: 42 Token/秒\n" +
        "会话费用估算: $0.343",
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

  it("injects formatted usage rows into the native tooltip DOM upon appearance", () => {
    const tooltipChildren: Array<{
      dataset: Record<string, string>;
      className: string;
      remove: () => void;
    }> = [];
    const tooltipElement = {
      tagName: "DIV",
      className: "flex w-38 flex-col gap-0.5 text-center",
      classList: {
        contains: (cls: string) =>
          ["flex", "w-38", "flex-col", "gap-0.5", "text-center"].includes(cls),
      },
      querySelectorAll: (sel: string) => (sel === "div" ? [tooltipElement] : []),
      append: (child: (typeof tooltipChildren)[number]) => tooltipChildren.push(child),
    };
    const rootTooltip = {
      tagName: "DIV",
      getAttribute: (name: string) => (name === "role" ? "tooltip" : null),
      querySelectorAll: (sel: string) => (sel === "div" ? [tooltipElement] : []),
      ownerDocument: null as unknown as Document,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 50 }),
    };
    const mockDocument = {
      createElement: (tag: string) => {
        const el = {
          tagName: tag.toUpperCase(),
          dataset: {} as Record<string, string>,
          style: {} as Record<string, string>,
          className: "",
          parentElement: tooltipElement,
          isConnected: true,
          replaceChildren: vi.fn(),
          remove: () => {
            const idx = tooltipChildren.indexOf(el);
            if (idx !== -1) tooltipChildren.splice(idx, 1);
          },
        };
        return el;
      },
      getElementById: (id: string) => (id === "ctx-tip-1" ? rootTooltip : null),
      body: {
        querySelectorAll: () => [rootTooltip],
      },
      defaultView: {},
    } as unknown as Document;
    rootTooltip.ownerDocument = mockDocument;

    const attributes = new Map<string, string>();
    const trigger = {
      ownerDocument: mockDocument,
      parentElement: null,
      hidden: false,
      getAttribute: (name: string) => attributes.get(name) ?? null,
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      removeAttribute: (name: string) => attributes.delete(name),
    } as unknown as HTMLElement;
    attributes.set("aria-describedby", "ctx-tip-1");

    syncRendererNativeContextUsage(trigger, {
      cacheHitRatePercent: 95,
      totalTokens: 50_000,
      totalCostUsd: 0.05,
    });

    expect(tooltipChildren.length).toBe(1);
    expect(tooltipChildren[0]?.dataset.codexhostNativeUsageDetailsText).toContain(
      "Latest cache hit: CH 95%",
    );
    expect(tooltipChildren[0]?.dataset.codexhostNativeUsageDetailsText).toContain(
      "Total tokens: 50k",
    );
    expect(tooltipChildren[0]?.dataset.codexhostNativeUsageDetailsText).toContain(
      "Session cost estimate: $0.050",
    );

    clearRendererNativeContextUsage(trigger);
    expect(tooltipChildren.length).toBe(0);
  });

  it("handles fallback tooltip matching by text pattern and dynamic MutationObserver appearance", () => {
    let observerCallback: (() => void) | null = null;
    class MockMutationObserver {
      constructor(callback: () => void) {
        observerCallback = callback;
      }
      observe() {}
      disconnect() {
        observerCallback = null;
      }
    }

    const tooltipChildren: Array<{
      dataset: Record<string, string>;
      className: string;
      remove: () => void;
    }> = [];
    let tooltipVisible = true;
    const tooltipElement = {
      tagName: "DIV",
      className: "flex w-38 flex-col gap-0.5 text-center",
      classList: {
        contains: (cls: string) =>
          ["flex", "w-38", "flex-col", "gap-0.5", "text-center"].includes(cls),
      },
      querySelectorAll: (sel: string) => (sel === "div" ? [tooltipElement] : []),
      append: (child: (typeof tooltipChildren)[number]) => tooltipChildren.push(child),
    };
    const rootTooltip = {
      tagName: "DIV",
      get hidden() {
        return !tooltipVisible;
      },
      textContent: "Context window: 12% used",
      getAttribute: (name: string) => (name === "role" ? "tooltip" : null),
      querySelectorAll: (sel: string) => (sel === "div" ? [tooltipElement] : []),
      ownerDocument: null as unknown as Document,
      getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 50 }),
    };

    const mockDocument = {
      createElement: (tag: string) => {
        const el = {
          tagName: tag.toUpperCase(),
          dataset: {} as Record<string, string>,
          style: {} as Record<string, string>,
          className: "",
          parentElement: tooltipElement,
          isConnected: true,
          replaceChildren: vi.fn(),
          remove: () => {
            const idx = tooltipChildren.indexOf(el);
            if (idx !== -1) tooltipChildren.splice(idx, 1);
          },
        };
        return el;
      },
      getElementById: () => null, // No aria-describedby match
      body: {
        querySelectorAll: (sel: string) =>
          sel === '[role="tooltip"]' ? (tooltipVisible ? [rootTooltip] : []) : [],
      },
      defaultView: {
        MutationObserver: MockMutationObserver,
        getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      },
    } as unknown as Document;
    rootTooltip.ownerDocument = mockDocument;

    const attributes = new Map<string, string>();
    const trigger = {
      ownerDocument: mockDocument,
      parentElement: null,
      hidden: false,
      getAttribute: (name: string) => attributes.get(name) ?? null,
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      removeAttribute: (name: string) => attributes.delete(name),
      getBoundingClientRect: () => ({ left: 10, top: 20, width: 24, height: 24 }),
    } as unknown as HTMLElement;

    // Start with tooltip not visible initially
    tooltipVisible = false;
    syncRendererNativeContextUsage(trigger, {
      cachedInputTokens: 8_000,
      totalTokens: 10_000,
    });
    // Nothing injected yet
    expect(tooltipChildren.length).toBe(0);

    const triggerObserver = (): void => {
      const cb = observerCallback as (() => void) | null;
      cb?.();
    };

    // Tooltip appears (e.g. user hovers trigger)
    tooltipVisible = true;
    expect(observerCallback).not.toBeNull();
    triggerObserver();

    // Injected via fallback text pattern
    expect(tooltipChildren.length).toBe(1);
    expect(tooltipChildren[0]?.dataset.codexhostNativeUsageDetailsText).toContain("Cache read: 8k");
    expect(tooltipChildren[0]?.dataset.codexhostNativeUsageDetailsText).toContain(
      "Total tokens: 10k",
    );

    // Tooltip dismisses (unhover)
    tooltipVisible = false;
    triggerObserver();
    expect(tooltipChildren.length).toBe(0);

    // Tooltip re-appears
    tooltipVisible = true;
    triggerObserver();
    expect(tooltipChildren.length).toBe(1);
    expect(tooltipChildren[0]?.dataset.codexhostNativeUsageDetailsText).toContain(
      "Total tokens: 10k",
    );

    clearRendererNativeContextUsage(trigger);
    expect(tooltipChildren.length).toBe(0);
    expect(observerCallback).toBeNull();
  });
});
