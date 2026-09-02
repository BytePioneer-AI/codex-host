import { describe, expect, it } from "vitest";

import {
  creditsFamilyFromSelection,
  creditsHeaderEntries,
  creditsPeriodLabel,
  creditsPopoverRows,
  creditsProviderShortLabel,
  creditsSelectionHint,
  formatRendererCreditsReset,
  rendererCreditsTone,
} from "../src/renderer-credits-control.js";
import { formatRendererCreditsPercent } from "../src/renderer-usage-control.js";

describe("Renderer credits control", () => {
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
    expect(formatRendererCreditsReset("not-a-date")).toBe("not-a-date");
  });

  it("shortens provider product labels for the header chips", () => {
    expect(creditsProviderShortLabel("Gemini Flash (5h)")).toBe("Gemini");
    expect(creditsProviderShortLabel("Grok Build")).toBe("Grok");
    expect(creditsProviderShortLabel("Codex (5h)")).toBe("Codex");
    expect(creditsProviderShortLabel("Claude (7d)")).toBe("Claude");
  });

  it("builds one header chip per provider family, keeping the hotter window", () => {
    expect(
      creditsHeaderEntries({
        usedPercent: 35,
        periodType: "weekly",
        productUsage: [
          { product: "Grok Build", usagePercent: 35 },
          { product: "Codex (5h)", usagePercent: 10 },
          { product: "Codex (7d)", usagePercent: 55 },
        ],
      }),
    ).toEqual([
      {
        label: "Grok",
        usedPercent: 35,
        products: [{ product: "Grok Build", usagePercent: 35 }],
      },
      {
        label: "Codex",
        usedPercent: 55,
        products: [
          { product: "Codex (5h)", usagePercent: 10 },
          { product: "Codex (7d)", usagePercent: 55 },
        ],
      },
    ]);
  });

  it("keeps the native 5-hour primary window when productUsage only has the 7-day bucket", () => {
    expect(
      creditsHeaderEntries({
        usedPercent: 62,
        periodType: "five_hour",
        resetsAt: "2026-08-31T16:00:00.000Z",
        productUsage: [
          {
            product: "7-day window",
            usagePercent: 18,
            resetsAt: "2026-09-07T11:00:00.000Z",
          },
        ],
      }).map((entry) => ({ label: entry.label, usedPercent: entry.usedPercent })),
    ).toEqual([
      { label: "5-hour", usedPercent: 62 },
      { label: "7-day", usedPercent: 18 },
    ]);
  });

  it("maps the selected Model onto a quota family", () => {
    expect(creditsFamilyFromSelection("grok-cli / grok-4")).toBe("Grok");
    expect(creditsFamilyFromSelection("agy / gemini-3.7-flash-tiered")).toBe("Gemini");
    expect(creditsFamilyFromSelection("codex / gpt-5.4")).toBe("Codex");
    expect(creditsFamilyFromSelection("agy / claude-sonnet-4-6")).toBe("Claude");
    expect(creditsFamilyFromSelection("omp-model-v1.abc")).toBeNull();
    expect(
      creditsSelectionHint({
        modelLabel: "grok-cli / grok-4",
        agent: "omp",
      }),
    ).toContain("grok-cli");
  });

  it("lists per-account rows instead of a duplicated family summary", () => {
    expect(
      creditsPopoverRows({
        label: "Gemini",
        usedPercent: 50,
        resetsAt: "2026-09-02T22:43:00.000Z",
        products: [
          {
            product: "Gemini Flash (5h)",
            usagePercent: 50,
            resetsAt: "2026-09-02T22:43:00.000Z",
            accounts: [
              {
                accountName: "user1@example.com",
                usagePercent: 80,
                resetsAt: "2026-09-02T22:43:00.000Z",
              },
              {
                accountName: "user2@example.com",
                usagePercent: 20,
                resetsAt: "2026-09-02T21:10:00.000Z",
              },
            ],
          },
        ],
      }),
    ).toEqual([
      {
        label: "user1@example.com",
        usagePercent: 80,
        resetsAt: "2026-09-02T22:43:00.000Z",
      },
      {
        label: "user2@example.com",
        usagePercent: 20,
        resetsAt: "2026-09-02T21:10:00.000Z",
      },
    ]);
  });

  it("puts the selected family first and keeps other model families for expand", () => {
    expect(
      creditsHeaderEntries(
        {
          usedPercent: 32.6,
          periodType: "weekly",
          productUsage: [
            { product: "Gemini Flash (5h)", usagePercent: 32.6 },
            { product: "Grok Build", usagePercent: 64 },
            { product: "Codex (5h)", usagePercent: 14 },
            { product: "Firecrawl (monthly)", usagePercent: 0 },
          ],
        },
        "grok-cli / grok-4",
      ).map((entry) => entry.label),
    ).toEqual(["Grok", "Gemini", "Codex"]);
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
