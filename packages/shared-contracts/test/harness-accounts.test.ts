import { describe, expect, it } from "vitest";
import {
  harnessAccountInspectParamsSchema,
  harnessAccountListParamsSchema,
  harnessAccountSnapshotSchema,
} from "../src/harness-accounts.js";

describe("Harness account request contracts", () => {
  it("requires a real quota or balance and never accepts credentials", () => {
    const balance = { amount: 0, currency: "USD" };
    expect(harnessAccountSnapshotSchema.parse({ label: "wallet", balance })).toEqual({
      label: "wallet",
      balance,
    });
    for (const value of [
      { label: "no telemetry" },
      { balance: { amount: -1, currency: "USD" } },
      { balance: { amount: Number.NaN, currency: "USD" } },
      { balance: { amount: 1, currency: "" } },
      { balance, token: "private" },
    ]) {
      expect(harnessAccountSnapshotSchema.safeParse(value).success).toBe(false);
    }
  });

  it("supports optional forced refresh without accepting unrelated fields", () => {
    expect(
      harnessAccountInspectParamsSchema.parse({ harnessId: "sample-agent", refresh: true }),
    ).toEqual({ harnessId: "sample-agent", refresh: true });
    expect(harnessAccountListParamsSchema.parse({ refresh: true })).toEqual({ refresh: true });
    expect(harnessAccountListParamsSchema.safeParse({ token: "private" }).success).toBe(false);
  });
});
