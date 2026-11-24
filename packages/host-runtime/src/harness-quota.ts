import type { HarnessAdapter } from "@codexhost/harness-adapter";
import {
  deriveQuotaPoolKey,
  evaluateQuotaAvailability,
  harnessQuotaListResultSchema,
  rankAlternativeHarnesses,
  type AccountBalanceSnapshot,
  type AccountCreditsSnapshot,
  type HarnessAccountInspectResult,
  type HarnessAccountSnapshot,
  type HarnessPluginDescriptor,
  type HarnessQuotaListResult,
  type HarnessQuotaSummary,
} from "@codexhost/shared-contracts";

import { listedHarnessAccounts } from "./harness-accounts.js";
import type { HarnessQuotaInput } from "./delegation-types.js";

export interface OfficialCodexQuotaReading {
  email?: string;
  plan?: string;
  credits: AccountCreditsSnapshot | null;
  hasResetCredits?: boolean;
}

function summaryFromSnapshot(input: {
  harnessId: string;
  harnessName: string;
  credits?: AccountCreditsSnapshot | null;
  balance?: AccountBalanceSnapshot | null;
  scopeId?: string;
  hasResetCredits?: boolean;
  accounts?: HarnessAccountSnapshot[];
}): HarnessQuotaSummary {
  const evaluation = evaluateQuotaAvailability({
    ...(input.credits !== undefined ? { credits: input.credits } : {}),
    ...(input.balance !== undefined ? { balance: input.balance } : {}),
    harnessId: input.harnessId,
    ...(input.scopeId ? { scopeId: input.scopeId } : {}),
  });
  const primaryScope = evaluation.windows.find((window) => window.isPrimary)?.scopeId;
  const effectiveScope =
    input.scopeId ??
    (primaryScope && primaryScope.toLowerCase() !== input.harnessId.toLowerCase()
      ? primaryScope
      : undefined);
  const poolKey = deriveQuotaPoolKey({
    harnessId: input.harnessId,
    ...(effectiveScope ? { scopeId: effectiveScope } : {}),
  });
  return {
    harnessId: input.harnessId,
    harnessName: input.harnessName,
    poolKey,
    status: evaluation.status,
    windows: evaluation.windows,
    blockingWindows: evaluation.blockingWindows,
    blockingPeriods: evaluation.blockingPeriods,
    ...(evaluation.minRemainingPercent !== undefined
      ? { minRemainingPercent: evaluation.minRemainingPercent }
      : {}),
    ...(evaluation.earliestUnblockAt ? { earliestUnblockAt: evaluation.earliestUnblockAt } : {}),
    allBlockingResetsKnown: evaluation.allBlockingResetsKnown,
    ...(input.hasResetCredits ? { hasResetCredits: true } : {}),
    ...(input.balance ? { balance: input.balance } : {}),
    ...(input.accounts?.length ? { accounts: input.accounts } : {}),
  };
}

/**
 * Aggregates read-only quota telemetry across official Codex and installed external Harnesses.
 * When `input.harnessId` is provided, only that Harness is queried so unrelated CLI probes are skipped.
 */
export async function collectHarnessQuotas(options: {
  input?: HarnessQuotaInput;
  readCodex?: (refresh: boolean) => Promise<OfficialCodexQuotaReading | null>;
  adapters: Iterable<HarnessAdapter>;
  descriptors: readonly HarnessPluginDescriptor[];
  inspectHarnessAccount: (
    adapter: HarnessAdapter,
    refresh: boolean,
  ) => Promise<HarnessAccountInspectResult>;
  now?: () => number;
}): Promise<HarnessQuotaListResult> {
  const refresh = options.input?.refresh === true;
  const filterHarnessId = options.input?.harnessId;
  const scopeId = options.input?.scopeId?.trim() || undefined;
  const summaries: HarnessQuotaSummary[] = [];

  const includeCodex = !filterHarnessId || filterHarnessId === "codex";
  const codexPromise =
    includeCodex && options.readCodex
      ? options.readCodex(refresh).catch(() => null)
      : Promise.resolve(null);

  const selectedAdapters = [...options.adapters].filter(
    (adapter) => !filterHarnessId || adapter.harnessId === filterHarnessId,
  );
  const adapterPromises = selectedAdapters.map(async (adapter) => {
    const descriptorName =
      options.descriptors.find((plugin) => plugin.id === adapter.harnessId)?.name ??
      adapter.harnessId;
    if (!adapter.inspectAccount && !adapter.inspectAccounts) {
      const cachedCredits = adapter.credits?.() ?? null;
      const cachedBalance = cachedCredits ? null : (adapter.balance?.() ?? null);
      return summaryFromSnapshot({
        harnessId: adapter.harnessId,
        harnessName: descriptorName,
        credits: cachedCredits,
        balance: cachedBalance,
        ...(scopeId ? { scopeId } : {}),
      });
    }
    const inspection = await options.inspectHarnessAccount(adapter, refresh).catch(() => null);
    const rows = inspection ? listedHarnessAccounts(inspection) : [];
    const accounts: HarnessAccountSnapshot[] = rows.map((row) => ({
      ...(row.email ? { email: row.email } : {}),
      ...(row.label ? { label: row.label } : {}),
      ...(row.plan ? { plan: row.plan } : {}),
      ...(row.credits ? { credits: row.credits } : {}),
      ...(row.balance ? { balance: row.balance } : {}),
    }));
    const credits =
      accounts.find((account) => account.credits)?.credits ?? adapter.credits?.() ?? null;
    const balance = credits
      ? null
      : (accounts.find((account) => account.balance)?.balance ?? adapter.balance?.() ?? null);
    return summaryFromSnapshot({
      harnessId: adapter.harnessId,
      harnessName: inspection?.harnessName ?? descriptorName,
      credits,
      balance,
      ...(scopeId ? { scopeId } : {}),
      ...(accounts.length ? { accounts } : {}),
    });
  });

  const [codex, ...externalSummaries] = await Promise.all([codexPromise, ...adapterPromises]);
  if (includeCodex) {
    const codexAccount: HarnessAccountSnapshot[] = codex?.credits
      ? [
          {
            ...(codex.email ? { email: codex.email } : {}),
            ...(codex.plan ? { plan: codex.plan } : {}),
            credits: codex.credits,
          },
        ]
      : [];
    summaries.push(
      summaryFromSnapshot({
        harnessId: "codex",
        harnessName: "Codex",
        credits: codex?.credits ?? null,
        ...(scopeId ? { scopeId } : {}),
        ...(codex?.hasResetCredits ? { hasResetCredits: true } : {}),
        ...(codexAccount.length ? { accounts: codexAccount } : {}),
      }),
    );
  }
  summaries.push(...externalSummaries);

  return harnessQuotaListResultSchema.parse({
    observedAt: new Date((options.now ?? Date.now)()).toISOString(),
    harnesses: summaries,
    availableAlternatives: rankAlternativeHarnesses(summaries),
  });
}
