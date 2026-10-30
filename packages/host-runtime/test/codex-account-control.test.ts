import { describe, expect, it, vi } from "vitest";

import {
  currentCodexAccountFromOfficialRead,
  SingleNativeCodexAccount,
} from "../src/account/codex-account-control.js";

describe("Codex Account control fallbacks", () => {
  it("projects native state without implementing a managed login path", () => {
    const summary = vi.fn(() => ({
      version: 2 as const,
      currentAccountId: null,
      phase: "ready" as const,
      revision: 1,
      accounts: [],
    }));
    const control = new SingleNativeCodexAccount(summary);
    expect(control.snapshot()).toEqual(summary());
    expect(control.refresh).toBeUndefined();
  });

  it("maps official account/read to a current-only display identity", () => {
    expect(currentCodexAccountFromOfficialRead({ account: null })).toBeNull();
    expect(
      currentCodexAccountFromOfficialRead({
        account: { type: "chatgpt", email: "a@example.com", planType: "pro" },
      }),
    ).toEqual({
      accountId: "current",
      label: "a@example.com",
      email: "a@example.com",
      planType: "pro",
    });
  });
});
