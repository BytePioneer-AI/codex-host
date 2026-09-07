import type { CodexAccountSummary } from "@codexhost/shared-contracts";
import type { RendererModelClient } from "./renderer-model-client.js";

export function resolveCodexAccountSelection(
  accounts: readonly CodexAccountSummary[],
  overrideAccountId: string | null,
): {
  activeAccountId: string | null;
  overrideAccountId: string | null;
  selectedAccountId: string | null;
} {
  const activeAccountId = accounts.find((account) => account.active)?.accountId ?? null;
  const validOverrideAccountId = accounts.some((account) => account.accountId === overrideAccountId)
    ? overrideAccountId
    : null;
  return {
    activeAccountId,
    overrideAccountId: validOverrideAccountId,
    selectedAccountId: validOverrideAccountId ?? activeAccountId,
  };
}

/** Owned by one Host and one concrete request client, never the active-route facade. */
export class RendererCodexAccountState {
  accounts: readonly CodexAccountSummary[] = [];
  overrideAccountId: string | null = null;
  switching = false;
  #request: Promise<void> | null = null;

  constructor(readonly client: RendererModelClient) {}

  get selection(): ReturnType<typeof resolveCodexAccountSelection> {
    return resolveCodexAccountSelection(this.accounts, this.overrideAccountId);
  }

  refresh(): Promise<void> {
    if (this.#request) return this.#request;
    this.#request = Promise.resolve()
      .then(() => this.client.listCodexAccounts())
      .then((result) => {
        this.accounts = result.accounts;
        this.overrideAccountId = this.selection.overrideAccountId;
      })
      .catch(() => {
        // Keep only this Host's last known data on transient failures. A Host
        // without the Account API starts empty and keeps the plain Codex option.
      })
      .finally(() => {
        this.#request = null;
      });
    return this.#request;
  }
}
