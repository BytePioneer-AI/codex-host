import { describe, expect, it } from "vitest";

import { codexAccountListResultSchema, codexAccountUsageResultSchema } from "../src/index.js";

const baseSnapshot = {
  version: 2 as const,
  currentAccountId: "account-a",
  phase: "ready" as const,
  revision: 7,
  accounts: [{ accountId: "account-a", label: "Account A", email: "a@example.com" }],
};

describe("Codex Account browser contracts", () => {
  it("keeps a current-only snapshot and excludes credential locations", () => {
    expect(codexAccountListResultSchema.parse(baseSnapshot)).toEqual(baseSnapshot);
    expect(() =>
      codexAccountListResultSchema.parse({
        ...baseSnapshot,
        accounts: [{ ...baseSnapshot.accounts[0], codexHome: "/private/home" }],
      }),
    ).toThrow();
  });

  it("rejects retired multi-account fields", () => {
    expect(
      codexAccountListResultSchema.safeParse({ ...baseSnapshot, phase: "changing" }).success,
    ).toBe(false);
    expect(
      codexAccountListResultSchema.safeParse({
        ...baseSnapshot,
        capabilities: { manage: true, switch: true, login: true, delete: true },
      }).success,
    ).toBe(false);
    expect(
      codexAccountListResultSchema.safeParse({
        ...baseSnapshot,
        pendingOperation: { operationId: "login-1", kind: "login" },
      }).success,
    ).toBe(false);
    expect(
      codexAccountListResultSchema.safeParse({
        ...baseSnapshot,
        accounts: [{ ...baseSnapshot.accounts[0], requiresLogin: true }],
      }).success,
    ).toBe(false);
    expect(
      codexAccountListResultSchema.safeParse({
        ...baseSnapshot,
        accounts: [
          baseSnapshot.accounts[0],
          { accountId: "account-b", label: "Account B", email: "b@example.com" },
        ],
      }).success,
    ).toBe(false);
  });

  it("requires quota freshness and observation time", () => {
    expect(
      codexAccountUsageResultSchema.parse({
        accountId: "account-a",
        usage: null,
        freshness: "cached",
        observedAt: "2026-09-11T00:00:00.000Z",
      }),
    ).toMatchObject({ freshness: "cached" });
  });
});
