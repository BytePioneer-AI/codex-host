import { describe, expect, it, vi } from "vitest";
import {
  RendererCodexAccountState,
  shouldApplyCodexAccountSnapshot,
} from "../src/renderer-codex-account-state.js";
import { createRendererModelClient } from "../src/renderer-model-client.js";

const account = (accountId: string) => ({
  accountId,
  label: accountId,
});

const snapshot = (currentAccountId: string | null, revision: number, instanceId = "host-a") => ({
  version: 2 as const,
  currentAccountId,
  phase: "ready" as const,
  revision,
  instanceId,
  capabilities: { manage: true, switch: true, login: true, delete: true },
  accounts: currentAccountId ? [account(currentAccountId)] : [],
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
    response.resolve(snapshot("default", 1));
    await first;
    expect(sendRequest).toHaveBeenCalledExactlyOnceWith("codexhost/account/list", {});
    expect(state.readyAccountId).toBe("default");
  });

  it("does not inherit another Host's Account state when the remote API is absent", async () => {
    const local = createState(async () => snapshot("default", 1));
    const remote = createState(async () => {
      throw new Error("Method not found");
    });
    await local.refresh();
    local.switching = true;
    await remote.refresh();
    expect(remote.accounts).toEqual([]);
    expect(remote.readyAccountId).toBeNull();
    expect(remote.switching).toBe(false);
    expect(local.readyAccountId).toBe("default");
  });

  it("preserves the current identity on transient failure and accepts newer state", async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce(snapshot("default", 1))
      .mockRejectedValueOnce(new Error("disconnected"))
      .mockResolvedValueOnce(snapshot(null, 2));
    const state = createState(sendRequest);
    await state.refresh();
    await state.refresh();
    expect(state.readyAccountId).toBe("default");
    await state.refresh();
    expect(state.readyAccountId).toBeNull();
  });

  it("rejects stale revisions within an epoch but accepts a fresh Host epoch", () => {
    expect(
      shouldApplyCodexAccountSnapshot(
        { instanceId: "host-a", revision: 9 },
        { instanceId: "host-a", revision: 8 },
      ),
    ).toBe(false);
    expect(
      shouldApplyCodexAccountSnapshot(
        { instanceId: "host-a", revision: 9 },
        { instanceId: "host-b", revision: 0 },
      ),
    ).toBe(true);
    expect(
      shouldApplyCodexAccountSnapshot({ instanceId: "host-a", revision: 9 }, { revision: 10 }),
    ).toBe(false);
  });
});
