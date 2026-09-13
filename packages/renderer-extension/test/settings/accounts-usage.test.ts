import { describe, expect, it, vi } from "vitest";
import type { AccountCreditsSnapshot } from "@codexhost/shared-contracts";

vi.mock("../../src/settings/icons.js", () => ({
  createRendererSettingsIcon: () => "icon",
}));

import {
  renderAccountResetCredits,
  renderAccountUsage as renderUsage,
  resetCreditDetailLine,
  type AccountUsageViewState,
} from "../../src/settings/accounts-usage.js";
import { rendererSettingsMessages } from "../../src/settings/localization.js";

class FakeElement {
  readonly children: unknown[] = [];
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly listeners = new Map<string, () => void>();
  className = "";
  textContent = "";
  title = "";
  type = "";
  disabled = false;
  constructor(readonly tagName: string) {}
  addEventListener(name: string, listener: () => void): void {
    this.listeners.set(name, listener);
  }
  append(...children: unknown[]): void {
    this.children.push(...children);
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

const document = {
  createElement: (tagName: string) => new FakeElement(tagName),
} as unknown as Document;
const messages = rendererSettingsMessages("zh-CN");
function descendants(root: FakeElement): FakeElement[] {
  return [
    root,
    ...root.children.flatMap((child) => (child instanceof FakeElement ? descendants(child) : [])),
  ];
}
function elements(root: HTMLElement): FakeElement[] {
  return descendants(root as unknown as FakeElement);
}
function text(root: HTMLElement): string {
  return elements(root)
    .map((el) => el.textContent)
    .join(" ");
}
const credits = {
  usedPercent: 91,
  periodType: "five_hour" as const,
  resetsAt: "2026-09-10T03:12:00.000Z",
};

function renderAccountUsage(
  document: Document,
  state: AccountUsageViewState | undefined,
  messages: ReturnType<typeof rendererSettingsMessages>,
  display: "used" | "remaining",
  onRetry: () => void,
): HTMLElement {
  const result = renderUsage(document, state, messages, display, onRetry);
  const root = document.createElement("div");
  root.append(...result.cells);
  if (result.additional) root.append(result.additional);
  return root;
}

function usage(snapshot: AccountCreditsSnapshot = credits, display: "used" | "remaining" = "used") {
  const result = renderAccountUsage(
    document,
    { status: "ready", credits: snapshot, freshness: "live", observedAt: null },
    messages,
    display,
    vi.fn(),
  );
  if (!result) throw new Error("Expected limits");
  return result;
}

describe("Account limit windows", () => {
  it("does not synthesize a 5h window for weekly-only accounts", () => {
    const result = renderAccountUsage(
      document,
      {
        status: "ready",
        credits: { usedPercent: 9, periodType: "seven_day" },
        freshness: "live",
        observedAt: null,
      },
      messages,
      "used",
      vi.fn(),
    );
    if (!result) throw new Error("Expected limits");
    expect(text(result)).toContain("7 天");
    expect(text(result)).toContain("—");
    expect(text(result)).not.toContain("未提供此窗口");
    expect(
      elements(result).filter((el) => el.className === "settings-account-usage__missing"),
    ).toHaveLength(1);
    expect(elements(result).filter((el) => el.attributes.get("role") === "meter")).toHaveLength(1);
  });

  it("preserves primary and product windows without summing or deduplicating them", () => {
    const result = renderAccountUsage(
      document,
      {
        status: "ready",
        freshness: "live",
        observedAt: null,
        credits: {
          ...credits,
          productUsage: [
            { product: "7-day window", usagePercent: 0 },
            { product: "GPT-5.3-Codex-Spark", usagePercent: 25 },
          ],
        },
      },
      messages,
      "used",
      vi.fn(),
    );
    if (!result) throw new Error("Expected limits");
    expect(
      elements(result)
        .filter((el) => el.attributes.get("role") === "meter")
        .map((el) => el.attributes.get("aria-valuenow")),
    ).toEqual(["91", "0", "25"]);
    expect(text(result)).toContain("7 天");
    expect(text(result)).toContain("GPT-5.3-Codex-Spark");
    expect(
      elements(result).filter((el) => el.className === "settings-account-usage__sub"),
    ).toHaveLength(1);
  });

  it("keeps the display mode accessible and warnings based on used usage", () => {
    const result = usage(credits, "remaining");
    expect(text(result)).toContain("9%");
    const meter = elements(result).find((el) => el.attributes.get("role") === "meter");
    expect(meter?.attributes.get("aria-valuenow")).toBe("9");
    expect(meter?.attributes.get("aria-label")).toBe("5 小时 · 剩余");
    expect(meter?.className).toContain("--hot");
    expect((meter?.children[0] as FakeElement).style.width).toBe("9%");
  });

  it.each([0, 100])("renders the %i percent boundary in either display mode", (usedPercent) => {
    for (const display of ["used", "remaining"] as const) {
      const result = usage({ ...credits, usedPercent }, display);
      expect(
        elements(result)
          .find((el) => el.attributes.get("role") === "meter")
          ?.attributes.get("aria-valuenow"),
      ).toBe(String(display === "used" ? usedPercent : 100 - usedPercent));
    }
  });

  it("keeps unavailable, loading, empty, and failed states distinct from zero usage", () => {
    expect(
      elements(renderAccountUsage(document, undefined, messages, "used", vi.fn())).some(
        (el) => el.attributes.get("role") === "meter",
      ),
    ).toBe(false);
    for (const status of ["loading", "empty", "error"] as const) {
      const retry = vi.fn();
      const result = renderAccountUsage(document, { status }, messages, "used", retry);
      if (!result) throw new Error("Expected state");
      expect(elements(result).some((el) => el.attributes.get("role") === "meter")).toBe(false);
      if (status === "error") {
        elements(result)
          .find((el) => el.tagName === "button")
          ?.listeners.get("click")?.();
        expect(retry).toHaveBeenCalledOnce();
      } else expect(elements(result).some((el) => el.tagName === "button")).toBe(false);
      if (status === "loading")
        expect(elements(result).some((el) => el.attributes.get("aria-busy") === "true")).toBe(true);
    }
  });
});

describe("Quota comparison columns", () => {
  function columns(credits: AccountCreditsSnapshot) {
    const result = renderUsage(
      document,
      { status: "ready", credits, freshness: "live", observedAt: null },
      messages,
      "remaining",
      vi.fn(),
    );
    const [fiveHour, sevenDay] = result.cells;
    if (!fiveHour || !sevenDay) throw new Error("Expected two comparison columns");
    return { ...result, cells: [fiveHour, sevenDay] as const };
  }

  it("places weekly zero usage only in the 7-day column", () => {
    const result = columns({ usedPercent: 0, periodType: "weekly" });
    expect(elements(result.cells[0]).some((el) => el.attributes.get("role") === "meter")).toBe(
      false,
    );
    expect(
      elements(result.cells[1])
        .find((el) => el.attributes.get("role") === "meter")
        ?.attributes.get("aria-valuenow"),
    ).toBe("100");
    expect(result.additional).toBeNull();
  });

  it("places the exact secondary window in its column without merging duplicate reports", () => {
    const result = columns({
      ...credits,
      productUsage: [
        { product: "7-day window", usagePercent: 20 },
        { product: "7-day window", usagePercent: 35 },
      ],
    });
    expect(text(result.cells[0])).toContain("9%");
    expect(text(result.cells[1])).toContain("80%");
    expect(result.additional && text(result.additional)).toContain("65%");
  });

  it.each([
    { usedPercent: 20, periodType: "monthly" as const },
    { usedPercent: 20, periodType: "unknown" as const },
    { usedPercent: 20, periodType: "seven_day" as const, label: "Opus · 7-day" },
    { usedPercent: 20, periodType: "five_hour" as const, label: "Model group · 5-hour" },
  ])(
    "keeps monthly and scoped primary usage out of total columns: $periodType/$label",
    (credits) => {
      const result = columns(credits);
      expect(
        result.cells.flatMap(elements).some((el) => el.attributes.get("role") === "meter"),
      ).toBe(false);
      expect(result.additional && text(result.additional)).toContain(
        credits.label ?? (credits.periodType === "monthly" ? "月额度" : "额度"),
      );
      expect(result.additional && text(result.additional)).toContain("80%");
    },
  );

  it("retains model-specific, product and unknown reset data without inventing a window", () => {
    const result = columns({
      ...credits,
      resetsAt: "invalid",
      productUsage: [
        { product: "Sonnet · 7-day", usagePercent: 25 },
        { product: "GrokBuild", usagePercent: 0 },
      ],
    });
    expect(text(result.cells[1])).toContain("—");
    expect(text(result.cells[1])).not.toContain("未提供此窗口");
    expect(result.additional && text(result.additional)).toContain("Sonnet · 7-day");
    expect(result.additional && text(result.additional)).toContain("Build");
    expect(elements(result.cells[0]).some((el) => el.tagName === "time")).toBe(false);
  });
});

describe("Account reset-card details", () => {
  it("formats each available card's expiry", () => {
    const now = new Date(2026, 8, 10, 12, 0, 0);
    const expires = new Date(2026, 8, 10, 16, 12, 0);
    const line = resetCreditDetailLine(1, expires.toISOString(), messages, now);
    expect(line.startsWith("第 1 张 · ")).toBe(true);
    expect(line).toContain("今天");
    expect(line.endsWith("到期")).toBe(true);
  });

  it("does not invent a zero card count when no reset snapshot is provided", () => {
    expect(
      renderAccountResetCredits(document, credits, messages, {
        usingReset: false,
        resetDisabled: false,
      }),
    ).toBeNull();
  });

  it("shows a count and reset action even without per-card expiry data", () => {
    const onUseReset = vi.fn();
    const result = renderAccountResetCredits(
      document,
      { ...credits, resetCredits: { availableCount: 2 } },
      messages,
      { usingReset: false, resetDisabled: false, onUseReset },
    );
    if (!result) throw new Error("Expected reset details");
    expect(text(result.summary)).toContain("2 张");
    expect(elements(result.details).some((el) => el.tagName === "ul")).toBe(false);
    elements(result.details)
      .find((el) => el.tagName === "button")
      ?.listeners.get("click")?.();
    expect(onUseReset).toHaveBeenCalledOnce();
  });

  it("renders every expiry and disables consumption while another reset is pending", () => {
    const expiresAt = ["2026-09-10T16:12:00.000Z", "2026-09-18T08:00:00.000Z"];
    const result = renderAccountResetCredits(
      document,
      { ...credits, resetCredits: { availableCount: 2, nextExpiresAt: expiresAt[0], expiresAt } },
      messages,
      { usingReset: false, resetDisabled: true, onUseReset: vi.fn() },
    );
    if (!result) throw new Error("Expected reset details");
    expect(elements(result.details).filter((el) => el.tagName === "li")).toHaveLength(2);
    expect(text(result.details)).toContain("第 1 张");
    expect(text(result.details)).toContain("第 2 张");
    expect(elements(result.details).find((el) => el.tagName === "button")?.disabled).toBe(true);
  });
});
