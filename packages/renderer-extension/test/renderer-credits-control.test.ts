import { describe, expect, it, vi } from "vitest";

import {
  creditsPeriodLabel,
  formatRendererBalance,
  formatRendererCreditsReset,
  productLabel,
  rendererCreditsTone,
  renderRendererCreditsControl,
  type RendererCreditsControl,
} from "../src/renderer-credits-control.js";
import { formatRendererCreditsPercent } from "../src/renderer-usage-control.js";

describe("Renderer credits control", () => {
  it.each([null, { parentElement: null }])(
    "hides credits and closes the popover without an attached placement anchor (%j)",
    (anchor) => {
      const root = { style: { display: "inline-flex" } };
      const trigger = { setAttribute: vi.fn() };
      const popover = { hidden: false, matches: () => true, hidePopover: vi.fn() };
      const control = { root, trigger, popover, anchor } as unknown as RendererCreditsControl;

      expect(renderRendererCreditsControl(control, { usedPercent: 19, periodType: "weekly" })).toBe(
        false,
      );
      expect(root.style.display).toBe("none");
      expect(popover.hidePopover).toHaveBeenCalledOnce();
      expect(popover.hidden).toBe(true);
      expect(trigger.setAttribute).toHaveBeenCalledWith("aria-expanded", "false");
    },
  );

  it("formats a prepaid balance with its currency and falls back for unknown codes", () => {
    expect(formatRendererBalance({ amount: 12.34, currency: "CNY" }, "zh-CN")).toBe("¥12.34");
    expect(formatRendererBalance({ amount: 3, currency: "USD" })).toBe("$3.00");
    expect(formatRendererBalance({ amount: 1.5, currency: "not-a-code" })).toBe("1.50 not-a-code");
  });

  it("shows a balance chip without a ring or percentage when no quota is reported", () => {
    interface FakeElement {
      style: Record<string, string>;
      textContent: string;
      children: FakeElement[];
      attributes: Record<string, string>;
      append(...nodes: FakeElement[]): void;
      replaceChildren(...nodes: FakeElement[]): void;
      setAttribute(name: string, value: string): void;
    }
    const element = (): FakeElement => {
      const node: FakeElement = {
        style: {},
        textContent: "",
        children: [],
        attributes: {},
        append: (...nodes) => node.children.push(...nodes),
        replaceChildren: (...nodes) => {
          node.children = [...nodes];
        },
        setAttribute: (name, value) => {
          node.attributes[name] = value;
        },
      };
      return node;
    };
    const text = (node: FakeElement): string =>
      node.textContent + node.children.map((child) => text(child)).join("");
    vi.stubGlobal("document", { createElement: element });
    try {
      const ring = element();
      ring.children.push(element());
      const label = element();
      const trigger = Object.assign(element(), {
        title: "",
        querySelector: (selector: string) =>
          selector.includes("ring") ? ring : selector.includes("label") ? label : null,
      });
      const popover = element();
      const root = element();
      const control = {
        root,
        trigger,
        popover,
        anchor: { parentElement: {} },
      } as unknown as RendererCreditsControl;

      expect(
        renderRendererCreditsControl(control, null, "zh-CN", {
          amount: 12.34,
          currency: "CNY",
          label: "DeepSeek API",
        }),
      ).toBe(true);
      expect(root.style.display).toBe("inline-flex");
      expect(label.textContent).toBe("¥12.34");
      expect(ring.children).toEqual([]);
      expect(trigger.title).toBe("DeepSeek API 余额 ¥12.34");
      expect(popover.attributes["aria-label"]).toBe("账号余额详情");
      expect(text(popover)).toContain("DeepSeek API");
      expect(text(popover)).toContain("¥12.34");
      expect(text(popover)).not.toContain("%");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("maps used percent into a status tone", () => {
    expect(rendererCreditsTone(0)).toBe("ok");
    expect(rendererCreditsTone(52)).toBe("ok");
    expect(rendererCreditsTone(70)).toBe("warn");
    expect(rendererCreditsTone(89.9)).toBe("warn");
    expect(rendererCreditsTone(90)).toBe("hot");
  });

  it("formats the compact percent and period label", () => {
    expect(formatRendererCreditsPercent(47)).toBe("47%");
    expect(creditsPeriodLabel("weekly")).toBe("Weekly limit");
    expect(creditsPeriodLabel("monthly")).toBe("Monthly limit");
    expect(creditsPeriodLabel("five_hour")).toBe("5-hour limit");
    expect(creditsPeriodLabel("seven_day")).toBe("7-day limit");
    expect(creditsPeriodLabel("unknown")).toBe("Account limit");
    expect(creditsPeriodLabel("weekly", "zh-CN")).toBe("周额度");
    expect(creditsPeriodLabel("monthly", "zh-CN")).toBe("月额度");
    expect(creditsPeriodLabel("five_hour", "zh-CN")).toBe("5 小时额度");
    expect(creditsPeriodLabel("seven_day", "zh-CN")).toBe("7 天额度");
    expect(creditsPeriodLabel("unknown", "zh-CN")).toBe("账号额度");
    expect(formatRendererCreditsReset("not-a-date")).toBe("not-a-date");
  });

  it("uses structured periods and scopes, never display-string parsing", () => {
    const window = {
      product: "arbitrary native wording",
      usagePercent: 12,
      periodType: "five_hour" as const,
      scope: { id: "group-1", label: "Model group" },
    };
    expect(productLabel(window)).toBe("Model group · 5-hour limit");
    expect(productLabel(window, "zh-CN")).toBe("Model group · 5 小时额度");
    expect(productLabel({ ...window, product: "different punctuation" }, "zh-CN")).toBe(
      "Model group · 5 小时额度",
    );
    expect(productLabel({ product: "GrokBuild", usagePercent: 12 })).toBe("GrokBuild");
    expect(productLabel({ product: "7-day window", usagePercent: 12 }, "zh-CN")).toBe(
      "7-day window",
    );
    expect(
      productLabel(
        { product: "custom", usagePercent: 12, localizations: { "zh-CN": { label: "专属额度" } } },
        "zh-CN",
      ),
    ).toBe("专属额度");
  });

  it("formats a same-day reset as a precise time and every other reset as a dated time", () => {
    // Built with the local Date constructor throughout (never a bare UTC ISO string against a
    // separately-computed "now") so the "same calendar day" check holds regardless of the
    // machine's own timezone.
    const now = new Date(2026, 7, 25, 12, 0, 0);
    const sameDayReset = new Date(2026, 7, 25, 16, 12, 0);
    const nextWeekReset = new Date(2026, 8, 5, 18, 0, 0);

    expect(formatRendererCreditsReset(sameDayReset.toISOString(), now)).toBe(
      `${sameDayReset.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} today`,
    );
    expect(formatRendererCreditsReset(sameDayReset.toISOString(), now, "zh-CN")).toBe(
      `今天 ${sameDayReset.toLocaleTimeString("zh-CN", { hour: "numeric", minute: "2-digit" })}`,
    );
    expect(formatRendererCreditsReset(nextWeekReset.toISOString(), now)).toBe(
      nextWeekReset.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
    );
  });

  it("keeps the time when a near-term reset has crossed local midnight", () => {
    const now = new Date(2026, 7, 25, 23, 0, 0);
    const justAfterMidnight = new Date(2026, 7, 26, 0, 10, 0);
    expect(formatRendererCreditsReset(justAfterMidnight.toISOString(), now)).toBe(
      justAfterMidnight.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
    );
  });
});
