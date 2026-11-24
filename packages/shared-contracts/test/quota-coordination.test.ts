import { describe, expect, it } from "vitest";

import {
  deriveQuotaPoolKey,
  evaluateQuotaAvailability,
  rankAlternativeHarnesses,
  type AccountCreditsSnapshot,
  type HarnessQuotaSummary,
} from "../src/index.js";

describe("quota-coordination", () => {
  it("uses MAX(resetsAt) across exhausted 5-hour and 7-day windows", () => {
    const credits: AccountCreditsSnapshot = {
      periodType: "five_hour",
      usedPercent: 100,
      resetsAt: "2026-11-24T12:00:00.000Z",
      productUsage: [
        {
          product: "7-day window",
          periodType: "seven_day",
          usagePercent: 100,
          resetsAt: "2026-11-28T00:00:00.000Z",
        },
      ],
    };

    const result = evaluateQuotaAvailability({ credits, harnessId: "codex" });
    expect(result.status).toBe("exhausted");
    expect(result.blockingPeriods).toEqual(["five_hour", "seven_day"]);
    expect(result.earliestUnblockAt).toBe("2026-11-28T00:00:00.000Z");
    expect(result.allBlockingResetsKnown).toBe(true);
    expect(result.minRemainingPercent).toBe(0);
  });

  it("isolates model-scoped Antigravity buckets while keeping matching 5h and weekly windows together", () => {
    const credits: AccountCreditsSnapshot = {
      label: "Claude and GPT Models · 5-hour window",
      scope: { id: "Claude and GPT Models", label: "Claude and GPT Models" },
      periodType: "five_hour",
      usedPercent: 100,
      resetsAt: "2026-11-24T11:00:00.000Z",
      productUsage: [
        {
          product: "Claude and GPT Models · Weekly window",
          scope: { id: "Claude and GPT Models", label: "Claude and GPT Models" },
          periodType: "weekly",
          usagePercent: 40,
          resetsAt: "2026-11-29T00:00:00.000Z",
        },
        {
          product: "Gemini Models · 5-hour window",
          scope: { id: "Gemini Models", label: "Gemini Models" },
          periodType: "five_hour",
          usagePercent: 15,
          resetsAt: "2026-11-24T11:30:00.000Z",
        },
        {
          product: "Gemini Models · Weekly window",
          scope: { id: "Gemini Models", label: "Gemini Models" },
          periodType: "weekly",
          usagePercent: 20,
          resetsAt: "2026-11-29T00:00:00.000Z",
        },
      ],
    };

    const claudeScope = evaluateQuotaAvailability({
      credits,
      harnessId: "antigravity",
      scopeId: "Claude and GPT Models",
    });
    expect(claudeScope.status).toBe("exhausted");
    expect(claudeScope.earliestUnblockAt).toBe("2026-11-24T11:00:00.000Z");
    expect(claudeScope.windows).toHaveLength(2);

    const geminiScope = evaluateQuotaAvailability({
      credits,
      harnessId: "antigravity",
      scopeId: "Gemini Models",
    });
    expect(geminiScope.status).toBe("available");
    expect(geminiScope.minRemainingPercent).toBe(80);
    expect(geminiScope.windows).toHaveLength(2);

    const unmatched = evaluateQuotaAvailability({
      credits,
      harnessId: "antigravity",
      scopeId: "Unknown Family",
    });
    expect(unmatched.status).toBe("unknown");
  });

  it("ignores model-scoped Claude Code windows when unscoped, and applies them when scoped", () => {
    const credits: AccountCreditsSnapshot = {
      periodType: "five_hour",
      usedPercent: 30,
      resetsAt: "2026-11-24T12:00:00.000Z",
      productUsage: [
        {
          product: "7-day window",
          periodType: "seven_day",
          usagePercent: 50,
          resetsAt: "2026-11-29T00:00:00.000Z",
        },
        {
          product: "Opus · 7-day",
          periodType: "seven_day",
          scope: { id: "Opus", label: "Opus" },
          usagePercent: 100,
          resetsAt: "2026-11-28T00:00:00.000Z",
        },
        {
          product: "Sonnet · 7-day",
          periodType: "seven_day",
          scope: { id: "Sonnet", label: "Sonnet" },
          usagePercent: 10,
          resetsAt: "2026-11-28T00:00:00.000Z",
        },
      ],
    };

    expect(evaluateQuotaAvailability({ credits, harnessId: "claude-code" })).toMatchObject({
      status: "available",
      minRemainingPercent: 50,
    });
    expect(
      evaluateQuotaAvailability({ credits, harnessId: "claude-code", scopeId: "Opus" }),
    ).toMatchObject({
      status: "exhausted",
      earliestUnblockAt: "2026-11-28T00:00:00.000Z",
    });
    expect(
      evaluateQuotaAvailability({ credits, harnessId: "claude-code", scopeId: "Sonnet" }),
    ).toMatchObject({
      status: "available",
      minRemainingPercent: 50,
    });
  });

  it("applies Harness-wide scoped windows such as Kimi Code 5-hour alongside weekly", () => {
    const credits: AccountCreditsSnapshot = {
      periodType: "weekly",
      usedPercent: 40,
      resetsAt: "2026-11-29T00:00:00.000Z",
      productUsage: [
        {
          product: "Kimi Code · 5-hour window",
          periodType: "five_hour",
          scope: { id: "kimi-code", label: "Kimi Code" },
          usagePercent: 100,
          resetsAt: "2026-11-24T13:00:00.000Z",
        },
      ],
    };

    const evaluation = evaluateQuotaAvailability({ credits, harnessId: "kimi-code" });
    expect(evaluation.status).toBe("exhausted");
    expect(evaluation.blockingPeriods).toEqual(["five_hour"]);
    expect(evaluation.earliestUnblockAt).toBe("2026-11-24T13:00:00.000Z");
  });

  it("enforces minHeadroomPercent boundaries and distinguishes prepaidOnly from unknown", () => {
    const credits: AccountCreditsSnapshot = {
      periodType: "five_hour",
      usedPercent: 90,
      resetsAt: "2026-11-24T12:00:00.000Z",
    };

    expect(
      evaluateQuotaAvailability({ credits, harnessId: "codex", minHeadroomPercent: 10 }).status,
    ).toBe("available");
    expect(
      evaluateQuotaAvailability({ credits, harnessId: "codex", minHeadroomPercent: 15 }).status,
    ).toBe("exhausted");

    expect(
      evaluateQuotaAvailability({
        credits: null,
        balance: { amount: 50, currency: "CNY" },
        harnessId: "deepseek-harness",
      }).status,
    ).toBe("prepaidOnly");

    expect(evaluateQuotaAvailability({ credits: null, harnessId: "pi" }).status).toBe("unknown");
  });

  it("derives pool keys and ranks available alternatives excluding same Harness or shared pool", () => {
    expect(deriveQuotaPoolKey({ harnessId: "codex" })).toBe("codex:*");
    expect(deriveQuotaPoolKey({ harnessId: "antigravity", scopeId: "Gemini Models" })).toBe(
      "antigravity:gemini models",
    );
    expect(deriveQuotaPoolKey({ harnessId: "pi", poolKey: "Codex-Main" })).toBe("pool:codex-main");

    const summaries: HarnessQuotaSummary[] = [
      {
        harnessId: "claude-code",
        harnessName: "Claude Code",
        poolKey: "claude-code:*",
        status: "exhausted",
        windows: [],
        blockingWindows: [],
        blockingPeriods: ["five_hour"],
        minRemainingPercent: 0,
        earliestUnblockAt: "2026-11-24T12:00:00.000Z",
        allBlockingResetsKnown: true,
      },
      {
        harnessId: "codex",
        harnessName: "Codex",
        poolKey: "pool:shared-openai",
        status: "available",
        windows: [],
        blockingWindows: [],
        blockingPeriods: [],
        minRemainingPercent: 60,
        allBlockingResetsKnown: true,
      },
      {
        harnessId: "pi",
        harnessName: "Pi",
        poolKey: "pool:shared-openai",
        status: "available",
        windows: [],
        blockingWindows: [],
        blockingPeriods: [],
        minRemainingPercent: 60,
        allBlockingResetsKnown: true,
      },
      {
        harnessId: "antigravity",
        harnessName: "Antigravity",
        poolKey: "antigravity:gemini models",
        status: "available",
        windows: [],
        blockingWindows: [],
        blockingPeriods: [],
        minRemainingPercent: 85,
        allBlockingResetsKnown: true,
      },
      {
        harnessId: "deepseek-harness",
        harnessName: "DeepSeek",
        poolKey: "deepseek-harness:*",
        status: "prepaidOnly",
        windows: [],
        blockingWindows: [],
        blockingPeriods: [],
        allBlockingResetsKnown: false,
        balance: { amount: 12, currency: "CNY" },
      },
    ];

    expect(
      rankAlternativeHarnesses(summaries, {
        harnessId: "codex",
        poolKey: "pool:shared-openai",
      }),
    ).toEqual([
      {
        harnessId: "antigravity",
        harnessName: "Antigravity",
        poolKey: "antigravity:gemini models",
        minRemainingPercent: 85,
      },
    ]);
  });
});
