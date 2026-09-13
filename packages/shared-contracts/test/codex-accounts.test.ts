import { describe, expect, it } from "vitest";

import {
  codexAccountListResultSchema,
  codexAccountLoginCompletedSchema,
  codexAccountUsageResultSchema,
} from "../src/index.js";

const baseSnapshot = {
  version: 2 as const,
  currentAccountId: "account-a",
  phase: "ready" as const,
  revision: 7,
  capabilities: { manage: true, switch: true, login: true, delete: true },
  accounts: [{ accountId: "account-a", label: "Account A", email: "a@example.com" }],
};

describe("Codex Account browser contracts", () => {
  it("keeps the PR252 v2 snapshot compatible and excludes credential locations", () => {
    expect(codexAccountListResultSchema.parse(baseSnapshot)).toEqual(baseSnapshot);
    expect(() =>
      codexAccountListResultSchema.parse({
        ...baseSnapshot,
        accounts: [{ ...baseSnapshot.accounts[0], codexHome: "/private/home" }],
      }),
    ).toThrow();
  });

  it("accepts Host epoch, cleanup, recovery operation, and added capability reasons", () => {
    const snapshot = {
      ...baseSnapshot,
      phase: "unavailable" as const,
      instanceId: "host-epoch-2",
      cleanupRequired: true,
      pendingOperation: { operationId: "recover-1", kind: "recovery" as const },
      capabilities: {
        ...baseSnapshot.capabilities,
        recover: true,
        logout: false,
        reason: "keyring-unavailable" as const,
      },
    };
    expect(codexAccountListResultSchema.parse(snapshot)).toEqual(snapshot);
    expect(
      codexAccountListResultSchema.parse({
        ...snapshot,
        capabilities: { ...snapshot.capabilities, reason: "migration-required" },
      }).capabilities.reason,
    ).toBe("migration-required");
  });

  it("separates a saved login from cleanup completion", () => {
    expect(
      codexAccountLoginCompletedSchema.parse({
        accountId: "account-b",
        loginId: "login-1",
        success: false,
        error: "cleanup pending",
        saved: true,
        cleanupRequired: true,
      }),
    ).toMatchObject({ saved: true, cleanupRequired: true });
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
