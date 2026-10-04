import { describe, expect, it, vi } from "vitest";
import type { AccountCreditsSnapshot } from "@codexhost/shared-contracts";

vi.mock("../../src/settings/icons.js", () => ({
  createRendererSettingsIcon: () => "icon",
}));

import {
  accountUsageColumnLabel,
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
  colSpan = 1;
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
function elements(root: HTMLElement | undefined): FakeElement[] {
  if (!root) throw new Error("Expected rendered element");
  return descendants(root as unknown as FakeElement);
}
function text(root: HTMLElement | undefined): string {
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
  for (const cells of result.continuationCells) root.append(...cells);
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
    expect(text(result)).not.toContain("—");
    expect(text(result)).not.toContain("未提供此窗口");
    expect(
      elements(result).filter((el) => el.className === "settings-account-usage__missing"),
    ).toHaveLength(0);
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

  it("shows native quantities and keeps a zero cap empty", () => {
    const remaining = usage({ ...credits, used: 20, limit: 100, unit: "credits" }, "remaining");
    expect(text(remaining)).toContain("80 / 100 credits");

    const empty = usage(
      { ...credits, usedPercent: 0, used: 0, limit: 0, unit: "credits" },
      "remaining",
    );
    expect(text(empty)).toContain("0 / 0 credits");
    expect(text(empty)).toContain("—");
    expect(
      elements(empty)
        .find((element) => element.attributes.get("role") === "meter")
        ?.attributes.get("aria-valuenow"),
    ).toBe("0");
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
  it("uses period-independent headers in both display modes and locales", () => {
    expect(accountUsageColumnLabel("remaining", messages)).toBe("剩余额度");
    expect(accountUsageColumnLabel("used", messages)).toBe("已用额度");
    const english = rendererSettingsMessages("en");
    expect(accountUsageColumnLabel("remaining", english)).toBe("Remaining quota");
    expect(accountUsageColumnLabel("used", english)).toBe("Used quota");
  });

  it("places monthly quotas side by side and wraps further products within the quota area", () => {
    const result = columns({
      usedPercent: 0,
      periodType: "monthly",
      label: "Auto · monthly",
      resetsAt: credits.resetsAt,
      productUsage: [
        { product: "API · monthly", usagePercent: 2, resetsAt: credits.resetsAt },
        { product: "Extra", usagePercent: 30 },
      ],
    });
    expect(text(result.cells[0])).toContain("Auto · 月额度");
    expect(text(result.cells[0])).toContain("100%");
    expect(text(result.cells[1])).toContain("API · 月额度");
    expect(text(result.cells[1])).toContain("98%");
    expect(text(result.cells[0])).not.toContain("5 小时");
    expect(text(result.cells[1])).not.toContain("7 天");
    expect(result.continuationCells).toHaveLength(1);
    const [first] = result.continuationCells[0] ?? [];
    if (!first) throw new Error("Expected continuation quota cell");
    expect(text(first)).toContain("Extra");
    expect(first.colSpan).toBe(2);
    expect(result.continuationCells[0]).toHaveLength(1);
  });

  it("packs Kimi's weekly and scoped five-hour limits into one row", () => {
    const result = columns({
      usedPercent: 0,
      periodType: "weekly",
      productUsage: [{ product: "Kimi Code · 5-hour", usagePercent: 12 }],
    });
    expect(result.cells).toHaveLength(2);
    expect(result.continuationCells).toHaveLength(0);
    expect(text(result.cells[0])).toContain("周额度");
    expect(text(result.cells[1])).toContain("Kimi Code · 5 小时");
    expect(text(result.cells[1])).toContain("88%");
  });

  it("retains the period on each scoped quota", () => {
    const result = columns({
      usedPercent: 10,
      periodType: "five_hour",
      label: "Model group · 5-hour",
      productUsage: [{ product: "Model group · 7-day", usagePercent: 20 }],
    });
    expect(text(result.cells[0])).toContain("Model group · 5 小时");
    expect(text(result.cells[1])).toContain("Model group · 7 天");
  });

  function columns(credits: AccountCreditsSnapshot) {
    const result = renderUsage(
      document,
      { status: "ready", credits, freshness: "live", observedAt: null },
      messages,
      "remaining",
      vi.fn(),
    );
    return result;
  }

  it("spans both quota columns for a single weekly allowance", () => {
    const result = columns({ usedPercent: 0, periodType: "weekly" });
    expect(result.cells).toHaveLength(1);
    expect(result.cells[0]?.colSpan).toBe(2);
    expect(
      elements(result.cells[0])
        .find((el) => el.attributes.get("role") === "meter")
        ?.attributes.get("aria-valuenow"),
    ).toBe("100");
    expect(result.continuationCells).toHaveLength(0);
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
    expect(result.continuationCells).toHaveLength(1);
    const duplicate = result.continuationCells[0]?.[0];
    if (!duplicate) throw new Error("Expected duplicate quota cell");
    expect(text(duplicate)).toContain("65%");
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
    expect(renderAccountResetCredits(document, credits, messages)).toBeNull();
  });

  it("shows only a count without per-card expiry data", () => {
    const result = renderAccountResetCredits(
      document,
      { ...credits, resetCredits: { availableCount: 2 } },
      messages,
    );
    if (!result) throw new Error("Expected reset details");
    expect(text(result.summary)).toContain("2 张");
    expect(elements(result.details).some((el) => el.tagName === "ul")).toBe(false);
    expect(elements(result.details).some((el) => el.tagName === "button")).toBe(false);
  });

  it("renders every expiry without a consume action", () => {
    const expiresAt = ["2026-09-10T16:12:00.000Z", "2026-09-18T08:00:00.000Z"];
    const result = renderAccountResetCredits(
      document,
      { ...credits, resetCredits: { availableCount: 2, nextExpiresAt: expiresAt[0], expiresAt } },
      messages,
    );
    if (!result) throw new Error("Expected reset details");
    expect(elements(result.details).filter((el) => el.tagName === "li")).toHaveLength(2);
    expect(text(result.details)).toContain("第 1 张");
    expect(text(result.details)).toContain("第 2 张");
    expect(elements(result.details).some((el) => el.tagName === "button")).toBe(false);
  });
});
