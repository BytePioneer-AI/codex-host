import { describe, expect, it, vi } from "vitest";

import {
  SingleNativeCodexAccount,
  UnavailableCodexAccounts,
} from "../src/account/codex-account-control.js";

describe("Codex Account control fallbacks", () => {
  it("distinguishes unavailable security and migration reasons", () => {
    expect(new UnavailableCodexAccounts("keyring-unavailable").snapshot()).toMatchObject({
      phase: "unavailable",
      capabilities: { manage: false, reason: "keyring-unavailable" },
    });
    expect(new UnavailableCodexAccounts("migration-required").snapshot()).toMatchObject({
      capabilities: { manage: false, reason: "migration-required" },
    });
  });

  it("projects native state without implementing a second managed login path", async () => {
    const summary = vi.fn(() => ({
      version: 2 as const,
      currentAccountId: null,
      phase: "ready" as const,
      revision: 1,
      capabilities: {
        manage: false,
        switch: false,
        login: false,
        delete: false,
        reason: "ssh-single-account" as const,
      },
      accounts: [],
    }));
    const control = new SingleNativeCodexAccount(summary);
    expect(control.snapshot()).toEqual(summary());
    await expect(control.startLogin()).rejects.toMatchObject({ code: "unavailable" });
    await expect(control.logout()).rejects.toMatchObject({ code: "unavailable" });
    await expect(control.recover()).rejects.toMatchObject({ code: "unavailable" });
  });
});
