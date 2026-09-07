import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/settings/icons.js", () => ({
  createRendererSettingsIcon: () => "icon",
}));

import {
  renderAccountUsageCard,
  resetCreditDetailLine,
} from "../../src/settings/accounts-usage.js";
import { rendererSettingsMessages } from "../../src/settings/localization.js";

class FakeElement {
  readonly children: unknown[] = [];
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, string> = {};
  readonly #listeners = new Map<string, (event?: unknown) => void>();
  className = "";
  hidden = false;
  id = "";
  textContent = "";
  title = "";
  type = "";
  disabled = false;

  constructor(
    readonly tagName: string,
    readonly ownerDocument: FakeDocument,
  ) {}

  addEventListener(name: string, listener: (event?: unknown) => void): void {
    this.#listeners.set(name, listener);
  }

  append(...children: unknown[]): void {
    this.children.push(...children);
  }

  dispatch(name: string, event?: unknown): void {
    this.#listeners.get(name)?.(event);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

class FakeDocument {
  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }
}

function descendants(root: FakeElement): FakeElement[] {
  return [
    root,
    ...root.children.flatMap((child) => (child instanceof FakeElement ? descendants(child) : [])),
  ];
}

function byClass(root: FakeElement, className: string): FakeElement | undefined {
  return descendants(root).find((element) => element.className.split(" ").includes(className));
}

const credits = {
  usedPercent: 91,
  periodType: "five_hour" as const,
  resetsAt: "2026-09-10T03:12:00.000Z",
};

describe("Account usage reset-card details", () => {
  it("formats each available card's expiry", () => {
    const messages = rendererSettingsMessages("zh-CN");
    const now = new Date(2026, 8, 10, 12, 0, 0);
    const expires = new Date(2026, 8, 10, 16, 12, 0);
    const line = resetCreditDetailLine(1, expires.toISOString(), messages, now);
    expect(line.startsWith("第 1 张 · ")).toBe(true);
    expect(line).toContain("今天");
    expect(line.endsWith("到期")).toBe(true);
  });

  it("hides the details control when no per-card expiry is available", () => {
    const document = new FakeDocument();
    const card = renderAccountUsageCard(
      document as unknown as Document,
      {
        status: "ready",
        credits: { ...credits, resetCredits: { availableCount: 2 } },
      },
      rendererSettingsMessages("zh-CN"),
    );
    if (!card) throw new Error("Expected a usage card");
    expect(byClass(card as unknown as FakeElement, "settings-account-usage__resets-details")).toBe(
      undefined,
    );
  });

  it("reveals each reset-card expiry when the details control is opened", () => {
    const document = new FakeDocument();
    const soon = new Date(2026, 8, 10, 16, 12, 0).toISOString();
    const later = new Date(2026, 8, 18, 8, 0, 0).toISOString();
    const card = renderAccountUsageCard(
      document as unknown as Document,
      {
        status: "ready",
        credits: {
          ...credits,
          resetCredits: { availableCount: 2, nextExpiresAt: soon, expiresAt: [soon, later] },
        },
      },
      rendererSettingsMessages("zh-CN"),
    );
    if (!card) throw new Error("Expected a usage card");
    const root = card as unknown as FakeElement;
    const toggle = byClass(root, "settings-account-usage__resets-details");
    const list = byClass(root, "settings-account-usage__resets-list");
    if (!toggle || !list) throw new Error("Expected reset-card details control");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(list.hidden).toBe(true);
    expect(list.children).toHaveLength(2);
    toggle.dispatch("click");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(list.hidden).toBe(false);
    expect((list.children[0] as FakeElement).textContent).toContain("第 1 张");
    expect((list.children[1] as FakeElement).textContent).toContain("第 2 张");
  });
});
