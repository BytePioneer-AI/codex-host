import { describe, expect, it, vi } from "vitest";
import { RendererCodexAccountState } from "../src/renderer-codex-account-state.js";
import { createRendererModelClient } from "../src/renderer-model-client.js";

const account = (accountId: string, active = false) => ({
  accountId,
  label: accountId,
  codexHome: `/synthetic/${accountId}`,
  active,
  isDefault: accountId === "default",
});

function createState(sendRequest: (method: string, params: unknown) => Promise<unknown>) {
  const client = createRendererModelClient([{ sendRequest }]);
  if (!client) throw new Error("Test client is unavailable");
  return new RendererCodexAccountState(client);
}

describe("Host-scoped Codex Account state", () => {
  it("coalesces concurrent refreshes on the same concrete client", async () => {
    const response = Promise.withResolvers<unknown>();
    const sendRequest = vi.fn(() => response.promise);
    const state = createState(sendRequest);
    const first = state.refresh();
    const second = state.refresh();
    expect(second).toBe(first);
    response.resolve({ accounts: [account("default", true)] });
    await first;
    expect(sendRequest).toHaveBeenCalledExactlyOnceWith("codexhost/account/list", {});
    expect(state.selection.selectedAccountId).toBe("default");
  });

  it("does not inherit another Host's Accounts or override when the remote API is absent", async () => {
    const local = createState(async () => ({
      accounts: [account("default", true), account("other")],
    }));
    const remote = createState(async () => {
      throw new Error("Method not found");
    });
    await local.refresh();
    local.overrideAccountId = "other";
    local.switching = true;
    await remote.refresh();
    expect(remote.accounts).toEqual([]);
    expect(remote.selection.selectedAccountId).toBeNull();
    expect(remote.switching).toBe(false);
    expect(local.selection.selectedAccountId).toBe("other");
  });

  it("preserves this Host's selection on a transient failure and drops removed overrides on success", async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce({ accounts: [account("default", true), account("other")] })
      .mockRejectedValueOnce(new Error("disconnected"))
      .mockResolvedValueOnce({ accounts: [account("default", true)] });
    const state = createState(sendRequest);
    await state.refresh();
    state.overrideAccountId = "other";
    await state.refresh();
    expect(state.selection.selectedAccountId).toBe("other");
    await state.refresh();
    expect(state.overrideAccountId).toBeNull();
    expect(state.selection.selectedAccountId).toBe("default");
  });
});
