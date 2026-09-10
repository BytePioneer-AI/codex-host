import { describe, expect, it, vi } from "vitest";

import { RendererCodexAccountState } from "../src/renderer-codex-account-state.js";

describe("RendererCodexAccountState", () => {
  it("falls back to polling when Account notification registration is unavailable", async () => {
    const changed = vi.fn();
    const client = {
      subscribeCodexAccounts: vi.fn(() => {
        throw new Error("notifications unavailable");
      }),
      listCodexAccounts: vi.fn(async () => ({
        version: 2 as const,
        currentAccountId: "account-a",
        phase: "ready" as const,
        revision: 1,
        capabilities: { manage: true, switch: true, login: true, delete: true },
        accounts: [{ accountId: "account-a", label: "Account A" }],
      })),
    };

    const state = new RendererCodexAccountState(
      client as unknown as ConstructorParameters<typeof RendererCodexAccountState>[0],
      changed,
    );
    await state.refresh();

    expect(state.readyAccountId).toBe("account-a");
    expect(changed).not.toHaveBeenCalled();
    state.dispose();
  });
});
