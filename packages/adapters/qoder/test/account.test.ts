import { describe, expect, it, vi } from "vitest";

import { projectQoderAccount } from "../src/qoder-account.js";
import { QoderAdapter } from "../src/qoder-adapter.js";
import type { QoderQuery } from "../src/qoder-sdk-types.js";

describe("Qoder account quota", () => {
  it("queries native quota and identity, closes the probe, and isolates failures", async () => {
    const getUsageInfo = vi.fn(async (): Promise<unknown> => ({
      userQuota: { used: 20, total: 100, percentage: 20 },
    }));
    const accountInfo = vi.fn(async () => ({ email: "dev@example.com" }));
    const close = vi.fn(async () => undefined);
    const iterator = vi.fn(() => ({
      next: async () => ({ done: true as const, value: undefined }),
    }));
    const probe: QoderQuery = {
      getUsageInfo,
      accountInfo,
      close,
      interrupt: async () => undefined,
      [Symbol.asyncIterator]: iterator,
    };
    const queryFactory = vi.fn(() => probe);
    const adapter = new QoderAdapter({
      environment: {},
      queryFactory,
      resolveExecutable: () => "/test/qodercli",
    });
    await expect(adapter.inspectAccount()).resolves.toMatchObject({
      email: "dev@example.com",
      credits: { usedPercent: 20 },
    });
    expect(getUsageInfo).toHaveBeenCalledOnce();
    expect(accountInfo).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(iterator).not.toHaveBeenCalled();
    getUsageInfo.mockRejectedValueOnce(new Error("native quota unavailable"));
    await expect(adapter.inspectAccount()).resolves.toBeNull();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("projects plan credits and a shared package without inventing a percent", () => {
    expect(
      projectQoderAccount(
        {
          userQuota: { used: 20, total: 100, percentage: 20, unit: "credits" },
          orgResourcePackage: { available: true, used: 1, cap: 4, percentage: 25 },
          userType: "pro",
        },
        { email: "dev@example.com" },
      ),
    ).toMatchObject({
      email: "dev@example.com",
      plan: "pro",
      credits: {
        used: 20,
        limit: 100,
        unit: "credits",
        label: "Plan credits",
        productUsage: [{ product: "Shared resource credits", used: 1, limit: 4, unit: "credits" }],
      },
    });
    expect(projectQoderAccount({}, {})).toBeNull();
  });

  it("keeps a zero plan cap instead of dropping the quantity", () => {
    expect(
      projectQoderAccount(
        {
          userType: "teams",
          userQuota: { used: 0, total: 0, percentage: 0, unit: "credits" },
          orgResourcePackage: {
            available: true,
            used: 3,
            cap: 26000,
            percentage: 1,
            unit: "credits",
          },
        },
        { email: "dev@example.com" },
      ),
    ).toMatchObject({
      plan: "teams",
      credits: {
        used: 0,
        limit: 0,
        unit: "credits",
        label: "Plan credits",
        usedPercent: 0,
        productUsage: [
          {
            product: "Shared resource credits",
            used: 3,
            limit: 26000,
            unit: "credits",
            usagePercent: 1,
          },
        ],
      },
    });
  });
});
