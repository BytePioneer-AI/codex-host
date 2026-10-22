import { accountCreditsSnapshotSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";
import { projectCodexAccountCredits } from "../src/account-usage.ts";

const fiveHour = { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 };
const sevenDay = { usedPercent: 40, windowDurationMins: 10_080, resetsAt: 1_800_100_000 };

describe("Codex account quota projection", () => {
  it("projects both native windows without doubling the compatibility bucket", () => {
    const bucket = { limitId: "codex", primary: fiveHour, secondary: sevenDay };
    const result = projectCodexAccountCredits({
      rateLimits: bucket,
      rateLimitsByLimitId: { codex: bucket },
    });
    expect(result).toEqual({
      usedPercent: 25,
      periodType: "five_hour",
      resetsAt: new Date(1_800_000_000_000).toISOString(),
      productUsage: [
        {
          product: "7-day window",
          periodType: "seven_day",
          usagePercent: 40,
          resetsAt: new Date(1_800_100_000_000).toISOString(),
        },
      ],
    });
    expect(accountCreditsSnapshotSchema.safeParse(result).success).toBe(true);
  });

  it("preserves zero, exhausted and model-scoped windows with their native scope", () => {
    expect(
      projectCodexAccountCredits({
        rateLimitsByLimitId: {
          codex_other: { limitName: "Model group", primary: { ...fiveHour, usedPercent: 100 } },
          codex: { primary: { ...fiveHour, usedPercent: 0 } },
        },
      }),
    ).toMatchObject({
      usedPercent: 0,
      periodType: "five_hour",
      productUsage: [
        {
          scope: { id: "codex_other", label: "Model group" },
          periodType: "five_hour",
          usagePercent: 100,
        },
      ],
    });
    expect(
      projectCodexAccountCredits({
        rateLimits: { limitId: "codex_other", primary: fiveHour },
      }),
    ).toMatchObject({ scope: { id: "codex_other", label: "codex_other" } });
  });

  it("uses an available secondary without manufacturing a missing primary", () => {
    expect(projectCodexAccountCredits({ rateLimits: { secondary: sevenDay } })).toEqual({
      usedPercent: 40,
      periodType: "seven_day",
      resetsAt: new Date(1_800_100_000_000).toISOString(),
    });
  });

  it("keeps unfamiliar native durations and omits invalid reset times", () => {
    expect(
      projectCodexAccountCredits({
        rateLimits: { primary: { ...fiveHour, windowDurationMins: 15, resetsAt: 1e20 } },
      }),
    ).toEqual({ usedPercent: 25, periodType: "unknown", label: "15-minute window" });
  });

  it.each([undefined, null, {}, { rateLimits: {} }, { totalTokens: 123, costUsd: 1 }])(
    "returns no quota for missing account limits: %j",
    (value) => expect(projectCodexAccountCredits(value)).toBeNull(),
  );

  it.each([undefined, null, -1, 101, NaN, Infinity, "25"])(
    "rejects an unreported or invalid used percentage: %j",
    (usedPercent) =>
      expect(
        projectCodexAccountCredits({ rateLimits: { primary: { ...fiveHour, usedPercent } } }),
      ).toBeNull(),
  );
});
