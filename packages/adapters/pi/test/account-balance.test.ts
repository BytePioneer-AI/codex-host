import { describe, expect, it, vi } from "vitest";

import {
  fetchPiAccounts,
  projectDeepSeekBalance,
  projectSub2ApiUsage,
} from "../src/account-balance.js";

describe("Pi provider balance", () => {
  it("projects the first DeepSeek currency and refuses an invented percentage", () => {
    expect(
      projectDeepSeekBalance({
        balance_infos: [{ currency: "CNY", total_balance: "12.5" }],
      }),
    ).toEqual({
      label: "DeepSeek",
      balance: { amount: 12.5, currency: "CNY", label: "DeepSeek API" },
    });
    expect(projectDeepSeekBalance({ balance_infos: [] })).toBeNull();
    for (const amount of [null, "", " ", -1, "bad", Number.POSITIVE_INFINITY]) {
      expect(
        projectDeepSeekBalance({ balance_infos: [{ currency: "CNY", total_balance: amount }] }),
      ).toBeNull();
      expect(
        projectSub2ApiUsage({ mode: "unrestricted", balance: amount, unit: "USD" }, "wallet"),
      ).toBeNull();
    }
  });

  it("projects a sub2api wallet or key quota and skips unlimited subscriptions", () => {
    expect(
      projectSub2ApiUsage(
        {
          mode: "unrestricted",
          isValid: true,
          planName: "钱包余额",
          balance: 4.5,
          remaining: 4.5,
          unit: "USD",
        },
        "qingge",
      ),
    ).toEqual({
      label: "qingge",
      plan: "钱包余额",
      balance: { amount: 4.5, currency: "USD", label: "钱包余额" },
    });
    expect(
      projectSub2ApiUsage(
        { mode: "quota_limited", unit: "USD", quota: { remaining: "1.25" } },
        "qingge-2",
      ),
    ).toMatchObject({ label: "qingge-2", balance: { amount: 1.25, currency: "USD" } });
    expect(
      projectSub2ApiUsage(
        { mode: "unrestricted", remaining: -1, unit: "USD", planName: "订阅" },
        "sub",
      ),
    ).toBeNull();
    expect(projectSub2ApiUsage({ mode: "unrestricted", balance: 1 }, "qingge")).toBeNull();
    expect(projectSub2ApiUsage({ balance: 1, unit: "USD" }, "qingge")).toBeNull();
  });

  it("reads each custom Provider key only from that Provider origin", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.example.test/v1/usage");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-test");
      return new Response(
        JSON.stringify({
          mode: "unrestricted",
          isValid: true,
          planName: "钱包余额",
          balance: 8,
          unit: "USD",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    await expect(
      fetchPiAccounts({
        fetch: fetchImpl,
        readApiKey: async () => undefined,
        readProviders: async () => [
          { id: "qingge", apiKey: "sk-test", baseUrl: "https://api.example.test/v1" },
          { id: "blank", apiKey: "", baseUrl: "https://api.example.test" },
        ],
      }),
    ).resolves.toEqual([
      {
        label: "qingge",
        plan: "钱包余额",
        balance: { amount: 8, currency: "USD", label: "钱包余额" },
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
