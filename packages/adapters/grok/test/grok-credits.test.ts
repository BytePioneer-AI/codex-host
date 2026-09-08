import { describe, expect, it, vi } from "vitest";

import { fetchGrokAccount, parseGrokCreditsResponse } from "../src/grok-credits.js";

describe("Grok account discovery", () => {
  const now = new Date("2026-09-01T00:00:00.000Z");
  const auth = {
    "https://auth.x.ai::cli": {
      key: "native-oauth",
      email: "user@example.com",
      user_id: "native-user",
      expires_at: "2026-09-02T00:00:00Z",
    },
  };
  const fixture = () => ({
    environment: {},
    now,
    readAuthFile: vi.fn(async () => JSON.stringify(auth)),
    fetch: vi.fn(
      async () =>
        new Response(
          JSON.stringify({ config: { creditUsagePercent: 0, currentPeriod: { type: "WEEKLY" } } }),
        ),
    ),
  });

  it("returns only public identity and real quota, including zero usage", async () => {
    const input = fixture();
    expect(await fetchGrokAccount(input)).toEqual({
      email: "user@example.com",
      label: "native-user",
      credits: { usedPercent: 0, periodType: "weekly" },
    });
    expect(input.fetch).toHaveBeenCalledOnce();
  });

  it.each(["XAI_API_KEY", "GROK_API_KEY", "GROK_TOKEN"])(
    "does not use saved OAuth credentials in an explicit %s environment",
    async (key) => {
      const input = fixture();
      expect(await fetchGrokAccount({ ...input, environment: { [key]: "api-secret" } })).toBeNull();
      expect(input.readAuthFile).not.toHaveBeenCalled();
      expect(input.fetch).not.toHaveBeenCalled();
    },
  );

  it("does not send other issuers' tokens to xAI, or use expired credentials", async () => {
    const input = fixture();
    input.readAuthFile.mockResolvedValueOnce(
      JSON.stringify({ "https://other.example": { key: "other-secret" } }),
    );
    expect(await fetchGrokAccount(input)).toBeNull();
    expect(input.fetch).not.toHaveBeenCalled();
    expect(await fetchGrokAccount({ ...input, now: new Date("2027-01-01") })).toBeNull();
  });

  it("does not manufacture quota from a reset date, or reuse a result after logout", async () => {
    const input = fixture();
    expect(await fetchGrokAccount(input)).not.toBeNull();
    input.readAuthFile.mockResolvedValueOnce("{}");
    expect(await fetchGrokAccount(input)).toBeNull();
    expect(
      parseGrokCreditsResponse({ config: { billingPeriodEnd: "2026-09-02T00:00:00Z" } }),
    ).toBeNull();
  });
});

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
