import { assert, describe, expect, it, vi } from "vitest";
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
  accounts: currentAccountId ? [account(currentAccountId)] : [],
});

const fallbackAccountSnapshot = (
  revision: number,
  instanceId?: string,
  email = "first@example.test",
) => ({
  ...snapshot("current", revision, instanceId),
  accounts: [{ ...account("current"), email }],
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

  it.each([
    ["Account", snapshot("other", 3)],
    [
      "Account email under the fallback ID",
      fallbackAccountSnapshot(3, "host-a", "second@example.test"),
    ],
    ["Host instance", fallbackAccountSnapshot(1, "host-b")],
  ] as const)("shares pending usage across drafts until the %s changes", async (_, replacement) => {
    let accounts: ReturnType<typeof snapshot> = fallbackAccountSnapshot(1);
    const oldUsage = Promise.withResolvers<unknown>();
    const newUsage = Promise.withResolvers<unknown>();
    const inspectUsage = vi
      .fn<() => Promise<unknown>>()
      .mockReturnValueOnce(oldUsage.promise)
      .mockReturnValueOnce(newUsage.promise);
    const state = createState(async (method) => {
      return method === "codexhost/account/list" ? accounts : inspectUsage();
    });
    await state.refresh();
    const firstAccount = state.usageAccount;
    assert(firstAccount);
    const first = state.inspectUsage(firstAccount);
    assert(first);

    accounts = fallbackAccountSnapshot(2);
    await state.refresh();
    expect(state.inspectUsage(firstAccount)).toBe(first);
    expect(inspectUsage).toHaveBeenCalledTimes(1);

    accounts = replacement;
    await state.refresh();
    const nextAccount = state.usageAccount;
    assert(nextAccount);
    expect(state.inspectUsage(firstAccount)).toBeNull();
    const next = state.inspectUsage(nextAccount);
    assert(next);

    const usage = { accountId: "current", usage: null, freshness: "live", observedAt: null };
    oldUsage.resolve(usage);
    await first;
    expect(state.inspectUsage(nextAccount)).toBe(next);
    newUsage.resolve({ ...usage, accountId: replacement.currentAccountId });
    await next;
    expect(inspectUsage).toHaveBeenCalledTimes(2);
  });

  it("does not inherit another Host's Account state when the remote API is absent", async () => {
    const local = createState(async () => snapshot("default", 1));
    const remote = createState(async () => {
      throw new Error("Method not found");
    });
    await local.refresh();
    await remote.refresh();
    expect(remote.accounts).toEqual([]);
    expect(remote.readyAccountId).toBeNull();
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
