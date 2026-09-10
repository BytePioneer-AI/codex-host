import type { HarnessAccountListResult } from "@codexhost/shared-contracts";

export interface RendererHarnessAccountClient {
  listHarnessAccounts?(): Promise<HarnessAccountListResult>;
}

/** Read-only telemetry, deliberately separate from Codex Account IDs and mutations. */
export function createHarnessAccounts(
  signal: AbortSignal,
  getClient: () => RendererHarnessAccountClient | null,
  onChange: () => void,
) {
  let accounts: HarnessAccountListResult["accounts"] = [];
  let refreshing = false;
  return {
    get accounts(): readonly HarnessAccountListResult["accounts"][number][] {
      return accounts;
    },
    get refreshing() {
      return refreshing;
    },
    async refresh(): Promise<void> {
      if (refreshing || signal.aborted) return;
      const client = getClient();
      if (!client?.listHarnessAccounts) return;
      refreshing = true;
      onChange();
      try {
        const result = await client.listHarnessAccounts();
        if (!signal.aborted)
          accounts = [...result.accounts].sort((a, b) => a.harnessId.localeCompare(b.harnessId));
      } catch {
        // Do not keep stale identities after authentication changes or a failed query.
        if (!signal.aborted) accounts = [];
      } finally {
        refreshing = false;
        if (!signal.aborted) onChange();
      }
    },
  };
}
