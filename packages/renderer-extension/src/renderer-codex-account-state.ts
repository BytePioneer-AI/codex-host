import type { CodexAccountListResult, CodexAccountSummary } from "@codexhost/shared-contracts";
import type { RendererModelClient } from "./renderer-model-client.js";

export function resolveCurrentCodexAccountId(
  accounts: readonly CodexAccountSummary[],
  currentAccountId: string | null,
): string | null {
  return accounts.some((account) => account.accountId === currentAccountId)
    ? currentAccountId
    : null;
}

/** One Host-wide current Account snapshot; no Composer or draft override. */
export class RendererCodexAccountState {
  accounts: readonly CodexAccountSummary[] = [];
  currentAccountId: string | null = null;
  phase: CodexAccountListResult["phase"] = "unavailable";
  revision = 0;
  capabilities: CodexAccountListResult["capabilities"] = {
    manage: false,
    switch: false,
    login: false,
    delete: false,
  };
  switching = false;
  #request: Promise<void> | null = null;
  readonly #unsubscribe: (() => void) | undefined;

  constructor(
    readonly client: RendererModelClient,
    changed: () => void = () => undefined,
  ) {
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = client.subscribeCodexAccounts?.((state) => {
        if (this.#apply(state)) changed();
      });
    } catch {
      // Hosts without Account notifications remain usable through refresh polling.
    }
    this.#unsubscribe = unsubscribe;
  }

  get readyAccountId(): string | null {
    return resolveCurrentCodexAccountId(
      this.accounts,
      this.phase === "ready" ? this.currentAccountId : null,
    );
  }

  refresh(): Promise<void> {
    if (this.#request) return this.#request;
    this.#request = Promise.resolve()
      .then(() => this.client.listCodexAccounts())
      .then((result) => {
        this.#apply(result);
      })
      .catch(() => undefined)
      .finally(() => {
        this.#request = null;
      });
    return this.#request;
  }

  dispose(): void {
    this.#unsubscribe?.();
  }

  #apply(result: CodexAccountListResult): boolean {
    if (result.revision < this.revision) return false;
    this.accounts = result.accounts;
    this.currentAccountId = result.currentAccountId;
    this.phase = result.phase;
    this.revision = result.revision;
    this.capabilities = result.capabilities;
    this.switching = result.phase === "changing";
    return true;
  }
}
