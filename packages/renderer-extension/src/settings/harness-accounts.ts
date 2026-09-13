import type {
  HarnessAccountInspectParams,
  HarnessAccountInspectResult,
  HarnessAccountListResult,
  HarnessAccountSourceListResult,
} from "@codexhost/shared-contracts";

export interface RendererHarnessAccountClient {
  listHarnessAccountSources?(): Promise<HarnessAccountSourceListResult>;
  inspectHarnessAccount?(input: HarnessAccountInspectParams): Promise<HarnessAccountInspectResult>;
  /** Compatibility fallback for Hosts that predate progressive account inspection. */
  listHarnessAccounts?(): Promise<HarnessAccountListResult>;
}

type HarnessAccount = HarnessAccountListResult["accounts"][number];

function sortedAccounts(accounts: Iterable<HarnessAccount>): HarnessAccount[] {
  return [...accounts].sort((a, b) => a.harnessId.localeCompare(b.harnessId));
}

/** Read-only telemetry, deliberately separate from Codex Account IDs and mutations. */
export function createHarnessAccounts(
  signal: AbortSignal,
  getClient: () => RendererHarnessAccountClient | null,
  onChange: () => void,
) {
  let accounts: HarnessAccount[] = [];
  let refreshing = false;

  const loadProgressively = async (
    client: Required<
      Pick<RendererHarnessAccountClient, "listHarnessAccountSources" | "inspectHarnessAccount">
    >,
  ): Promise<boolean> => {
    let sources: HarnessAccountSourceListResult;
    try {
      sources = await client.listHarnessAccountSources();
    } catch {
      return false;
    }
    if (signal.aborted) return true;
    const byHarnessId = new Map(accounts.map((account) => [account.harnessId, account]));
    await Promise.all(
      sources.sources.map(async (source) => {
        try {
          const result = await client.inspectHarnessAccount({ harnessId: source.harnessId });
          if (signal.aborted || result.harnessId !== source.harnessId) return;
          if (result.account) {
            byHarnessId.set(result.harnessId, {
              ...result.account,
              harnessId: result.harnessId,
              harnessName: result.harnessName,
            });
          } else {
            byHarnessId.delete(source.harnessId);
          }
        } catch {
          if (!signal.aborted) byHarnessId.delete(source.harnessId);
        }
        if (!signal.aborted) {
          accounts = sortedAccounts(byHarnessId.values());
          onChange();
        }
      }),
    );
    return true;
  };

  return {
    get accounts(): readonly HarnessAccount[] {
      return accounts;
    },
    get refreshing() {
      return refreshing;
    },
    async refresh(): Promise<void> {
      if (refreshing || signal.aborted) return;
      const client = getClient();
      if (!client) return;
      refreshing = true;
      accounts = [];
      onChange();
      try {
        const progressive =
          client.listHarnessAccountSources && client.inspectHarnessAccount
            ? await loadProgressively({
                listHarnessAccountSources: client.listHarnessAccountSources.bind(client),
                inspectHarnessAccount: client.inspectHarnessAccount.bind(client),
              })
            : false;
        if (progressive || signal.aborted) return;
        if (!client.listHarnessAccounts) return;
        const result = await client.listHarnessAccounts();
        if (!signal.aborted) accounts = sortedAccounts(result.accounts);
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
