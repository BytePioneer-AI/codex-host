import { describe, expect, it } from "vitest";

import { parseGrokCreditsResponse } from "../src/grok-credits.js";

describe("Grok credits parsing", () => {
  it("reads the weekly SuperGrok credits payload", () => {
    expect(
      parseGrokCreditsResponse(
        {
          config: {
            currentPeriod: {
              type: "USAGE_PERIOD_TYPE_WEEKLY",
              end: "2026-08-20T03:32:07.498525+00:00",
            },
            creditUsagePercent: 33,
            productUsage: [{ product: "GrokBuild", usagePercent: 32 }],
          },
        },
        "2026-08-15T00:00:00.000Z",
      ),
    ).toEqual({
      usedPercent: 33,
      resetsAt: "2026-08-20T03:32:07.498525+00:00",
      periodType: "weekly",
      productUsage: [{ product: "GrokBuild", usagePercent: 32 }],
      fetchedAt: "2026-08-15T00:00:00.000Z",
    });
  });

  it("rejects payloads that do not contain a credits snapshot", () => {
    expect(parseGrokCreditsResponse({ config: { monthlyLimit: { val: 0 } } })).toBeNull();
  });
});
