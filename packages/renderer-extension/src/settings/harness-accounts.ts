import type {
  HarnessAccountInspectParams,
  HarnessAccountInspectResult,
  HarnessAccountListParams,
  HarnessAccountListResult,
  HarnessAccountSourceListResult,
} from "@codexhost/shared-contracts";

export interface RendererHarnessAccountClient {
  listHarnessAccountSources?(): Promise<HarnessAccountSourceListResult>;
  inspectHarnessAccount?(input: HarnessAccountInspectParams): Promise<HarnessAccountInspectResult>;
  /** Compatibility fallback for Hosts that predate progressive account inspection. */
  listHarnessAccounts?(input?: HarnessAccountListParams): Promise<HarnessAccountListResult>;
}

type HarnessAccount = HarnessAccountListResult["accounts"][number];

function accountKey(account: HarnessAccount): string {
  return [account.harnessId, account.email ?? "", account.label ?? "", account.plan ?? ""].join(
    "\0",
  );
}

function sortedAccounts(accounts: Iterable<HarnessAccount>): HarnessAccount[] {
  return [...accounts].sort((a, b) => {
    if (a.harnessId === "antigravity") return b.harnessId === "antigravity" ? 0 : 1;
    if (b.harnessId === "antigravity") return -1;
    return (
      a.harnessId.localeCompare(b.harnessId) ||
      (a.label ?? "").localeCompare(b.label ?? "") ||
      (a.email ?? "").localeCompare(b.email ?? "")
    );
  });
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
    force: boolean,
  ): Promise<boolean> => {
    let sources: HarnessAccountSourceListResult;
    try {
      sources = await client.listHarnessAccountSources();
    } catch {
      return false;
    }
    if (signal.aborted) return true;
    const byAccount = new Map(accounts.map((account) => [accountKey(account), account]));
    await Promise.all(
      sources.sources.map(async (source) => {
        try {
          const result = await client.inspectHarnessAccount({
            harnessId: source.harnessId,
            ...(force ? { refresh: true } : {}),
          });
          if (signal.aborted || result.harnessId !== source.harnessId) return;
          for (const key of [...byAccount.keys()]) {
            if (byAccount.get(key)?.harnessId === result.harnessId) byAccount.delete(key);
          }
          const reported = result.accounts ?? (result.account ? [result.account] : []);
          for (const account of reported) {
            const row = {
              ...account,
              harnessId: result.harnessId,
              harnessName: result.harnessName,
            };
            byAccount.set(accountKey(row), row);
          }
        } catch {
          if (!signal.aborted) {
            for (const key of [...byAccount.keys()]) {
              if (byAccount.get(key)?.harnessId === source.harnessId) byAccount.delete(key);
            }
          }
        }
        if (!signal.aborted) {
          accounts = sortedAccounts(byAccount.values());
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
    async refresh(force = false): Promise<void> {
      if (refreshing || signal.aborted) return;
      const client = getClient();
      if (!client) return;
      refreshing = true;
      accounts = [];
      onChange();
      try {
        const progressive =
          client.listHarnessAccountSources && client.inspectHarnessAccount
            ? await loadProgressively(
                {
                  listHarnessAccountSources: client.listHarnessAccountSources.bind(client),
                  inspectHarnessAccount: client.inspectHarnessAccount.bind(client),
                },
                force,
              )
            : false;
        if (progressive || signal.aborted) return;
        if (!client.listHarnessAccounts) return;
        const result = await client.listHarnessAccounts(force ? { refresh: true } : {});
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
