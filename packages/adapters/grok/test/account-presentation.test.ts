import { describe, expect, it, vi } from "vitest";
import { GrokAdapter } from "../src/grok-adapter.js";
import type { HarnessAccountSnapshot } from "@codexhost/shared-contracts";

describe("Grok account presentation ownership", () => {
  it("selects the plan overview in the plugin while retaining product details in the quota cache", async () => {
    const account: HarnessAccountSnapshot = {
      label: "native account",
      credits: {
        usedPercent: 25,
        periodType: "weekly",
        productUsage: [{ product: "GrokBuild", usagePercent: 30 }],
      },
    };
    const before = structuredClone(account);
    const createTransport = vi.fn(() => {
      throw new Error("Must not open a Session");
    });
    const adapter = new GrokAdapter(
      {},
      {
        createTransport,
        randomUUID: () => "unused",
        fetchAccount: async () => account,
        fetchCredits: async () => ({
          usedPercent: 25,
          periodType: "weekly",
          fetchedAt: "2026-10-01",
          productUsage: [{ product: "GrokBuild", usagePercent: 30 }],
        }),
      },
    );
    try {
      expect(await adapter.inspectAccount()).toEqual({
        label: "native account",
        credits: { usedPercent: 25, periodType: "weekly" },
      });
      expect(account).toEqual(before);
      await adapter.refreshCredits();
      expect(adapter.credits()?.productUsage).toHaveLength(1);
      expect(createTransport).not.toHaveBeenCalled();
    } finally {
      await adapter.close();
    }
  });
});
