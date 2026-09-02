import os from "node:os";
import path from "node:path";

import {
  type AccountCreditsAccountUsage,
  type AccountCreditsSnapshot,
} from "@codexhost/shared-contracts";

export interface OmniRouteConnection {
  id: string;
  provider: string;
  isActive: boolean;
  email?: string | null;
}

export interface OmniRouteCacheEntry {
  quotas?: Record<string, unknown> | null;
  plan?: string | null;
  message?: string | null;
  fetchedAt?: string | null;
}

export interface OmniRouteStorageData {
  connections: ReadonlyArray<OmniRouteConnection>;
  caches: Record<string, OmniRouteCacheEntry>;
}

export interface FetchOmpCreditsInput {
  environment?: NodeJS.ProcessEnv;
  dbPath?: string;
  queryDatabase?(
    dbPath: string,
  ): Promise<OmniRouteStorageData | null> | OmniRouteStorageData | null;
}

interface DatabaseSyncLike {
  prepare(query: string): { all(): unknown[] };
  close(): void;
}

type DatabaseSyncConstructor = new (
  location: string,
  options?: { readOnly?: boolean; open?: boolean },
) => DatabaseSyncLike;

let databaseSyncClass: DatabaseSyncConstructor | null | undefined;

async function loadDatabaseSync(): Promise<DatabaseSyncConstructor | null> {
  if (databaseSyncClass !== undefined) return databaseSyncClass;
  try {
    const sqliteModule = (await import("node:sqlite")) as {
      DatabaseSync?: DatabaseSyncConstructor;
    };
    databaseSyncClass = sqliteModule.DatabaseSync ?? null;
  } catch {
    databaseSyncClass = null;
  }
  return databaseSyncClass;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finitePercent(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(100, Math.max(0, value));
}

function nonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

function omnirouteHome(environment: NodeJS.ProcessEnv): string {
  return (
    environment.OMNIROUTE_DATA_DIR ??
    path.join(environment.HOME ?? environment.USERPROFILE ?? os.homedir(), ".omniroute")
  );
}

export function defaultOmniRouteDbPath(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.OMNIROUTE_DB_PATH ?? path.join(omnirouteHome(environment), "storage.sqlite");
}

function parseQuotaUsedPercent(quota: unknown): { usedPercent: number; resetsAt?: string } | null {
  if (!isRecord(quota)) return null;

  const resetsAt =
    typeof quota.resetAt === "string" && quota.resetAt.length > 0 ? quota.resetAt : undefined;

  if (quota.remainingPercentage !== undefined) {
    const rem = finitePercent(quota.remainingPercentage);
    if (rem !== undefined) {
      return {
        usedPercent: Math.min(100, Math.max(0, 100 - rem)),
        ...(resetsAt ? { resetsAt } : {}),
      };
    }
  }

  if (quota.isPercentageOnly && typeof quota.used === "number") {
    const used = finitePercent(quota.used);
    if (used !== undefined) {
      return {
        usedPercent: used,
        ...(resetsAt ? { resetsAt } : {}),
      };
    }
  }

  const used = nonNegativeNumber(quota.used);
  const total = nonNegativeNumber(quota.total);
  if (used !== undefined && total !== undefined && total > 0) {
    return {
      usedPercent: Math.min(100, Math.max(0, (used / total) * 100)),
      ...(resetsAt ? { resetsAt } : {}),
    };
  }

  if (used !== undefined && total === undefined) {
    const clamped = finitePercent(used);
    if (clamped !== undefined) {
      return {
        usedPercent: clamped,
        ...(resetsAt ? { resetsAt } : {}),
      };
    }
  }

  return null;
}

function connectionAccountName(conn: OmniRouteConnection): string {
  if (conn.email && conn.email.trim().length > 0) return conn.email.trim();
  return `Account (${conn.id.slice(0, 8)})`;
}

export function parseOmniRouteCredits(data: OmniRouteStorageData): AccountCreditsSnapshot | null {
  if (!data || !Array.isArray(data.connections) || !isRecord(data.caches)) return null;

  const activeConnections = data.connections.filter((c) => c.isActive);
  if (activeConnections.length === 0) return null;

  const productUsage: Array<{
    product: string;
    usagePercent: number;
    resetsAt?: string;
    accounts?: AccountCreditsAccountUsage[];
  }> = [];

  // 1. Antigravity pool (`agy`)
  const agyConns = activeConnections.filter((c) => c.provider === "agy");
  const agyFlashUsed: number[] = [];
  const agyFlashResets: string[] = [];
  const agyAccounts: AccountCreditsAccountUsage[] = [];

  for (const conn of agyConns) {
    const cache = data.caches[conn.id];
    const quotas = isRecord(cache?.quotas) ? cache.quotas : undefined;
    if (!quotas) continue;

    const flashQuota =
      quotas["gemini-3.7-flash-tiered"] ??
      quotas["gemini-3.7-flash-medium"] ??
      quotas["gemini-3.7-flash-high"] ??
      quotas["gemini-3.7-flash-low"] ??
      quotas["gemini-pro-agent"] ??
      quotas["gemini-3.1-flash-lite"] ??
      quotas["gemini-3.1-pro-low"] ??
      quotas["gemini-3.1-pro-high"];

    const flashParsed = parseQuotaUsedPercent(flashQuota);
    if (flashParsed) {
      agyFlashUsed.push(flashParsed.usedPercent);
      if (flashParsed.resetsAt) agyFlashResets.push(flashParsed.resetsAt);
      agyAccounts.push({
        accountName: connectionAccountName(conn),
        usagePercent: flashParsed.usedPercent,
        ...(flashParsed.resetsAt ? { resetsAt: flashParsed.resetsAt } : {}),
      });
    }
  }

  const pooledFlashUsed =
    agyFlashUsed.length > 0
      ? Math.round((agyFlashUsed.reduce((a, b) => a + b, 0) / agyFlashUsed.length) * 10) / 10
      : null;

  const sortedFlashResets = [...agyFlashResets].sort();
  const earliestFlashReset = sortedFlashResets[0];

  if (pooledFlashUsed !== null) {
    productUsage.push({
      product: "Gemini Flash (5h)",
      usagePercent: pooledFlashUsed,
      ...(earliestFlashReset ? { resetsAt: earliestFlashReset } : {}),
      ...(agyAccounts.length > 0 ? { accounts: agyAccounts } : {}),
    });
  }

  const agyClaudeUsed: number[] = [];
  const agyClaudeResets: string[] = [];
  const agyClaudeAccounts: AccountCreditsAccountUsage[] = [];
  for (const conn of agyConns) {
    const cache = data.caches[conn.id];
    const quotas = isRecord(cache?.quotas) ? cache.quotas : undefined;
    if (!quotas) continue;
    const claudeKey =
      Object.keys(quotas).find((key) => key.startsWith("claude-sonnet")) ??
      Object.keys(quotas).find((key) => key.startsWith("claude-"));
    if (!claudeKey) continue;
    const claudeParsed = parseQuotaUsedPercent(quotas[claudeKey]);
    if (!claudeParsed) continue;
    agyClaudeUsed.push(claudeParsed.usedPercent);
    if (claudeParsed.resetsAt) agyClaudeResets.push(claudeParsed.resetsAt);
    agyClaudeAccounts.push({
      accountName: connectionAccountName(conn),
      usagePercent: claudeParsed.usedPercent,
      ...(claudeParsed.resetsAt ? { resetsAt: claudeParsed.resetsAt } : {}),
    });
  }
  const pooledClaudeUsed =
    agyClaudeUsed.length > 0
      ? Math.round((agyClaudeUsed.reduce((a, b) => a + b, 0) / agyClaudeUsed.length) * 10) / 10
      : null;
  const earliestClaudeReset = [...agyClaudeResets].sort()[0];
  if (pooledClaudeUsed !== null) {
    productUsage.push({
      product: "Claude (5h)",
      usagePercent: pooledClaudeUsed,
      ...(earliestClaudeReset ? { resetsAt: earliestClaudeReset } : {}),
      ...(agyClaudeAccounts.length > 0 ? { accounts: agyClaudeAccounts } : {}),
    });
  }

  // 2. Grok (`grok-cli` / `grok`)
  let grokPrimaryUsed: number | null = null;
  let grokPrimaryReset: string | undefined;
  const grokBuildAccounts: AccountCreditsAccountUsage[] = [];
  const grokWeeklyAccounts: AccountCreditsAccountUsage[] = [];
  const grokConns = activeConnections.filter(
    (c) => c.provider === "grok-cli" || c.provider === "grok",
  );

  for (const conn of grokConns) {
    const cache = data.caches[conn.id];
    const quotas = isRecord(cache?.quotas) ? cache.quotas : undefined;
    if (!quotas) continue;

    const weekly = parseQuotaUsedPercent(quotas.weekly);
    const build = parseQuotaUsedPercent(quotas.product_grok_build);

    if (weekly) {
      grokWeeklyAccounts.push({
        accountName: connectionAccountName(conn),
        usagePercent: weekly.usedPercent,
        ...(weekly.resetsAt ? { resetsAt: weekly.resetsAt } : {}),
      });
    }

    if (build) {
      const reset = build.resetsAt ?? weekly?.resetsAt;
      grokBuildAccounts.push({
        accountName: connectionAccountName(conn),
        usagePercent: build.usedPercent,
        ...(reset ? { resetsAt: reset } : {}),
      });
    }
  }

  if (grokWeeklyAccounts.length > 0) {
    grokPrimaryUsed =
      Math.round(
        (grokWeeklyAccounts.reduce((a, b) => a + b.usagePercent, 0) / grokWeeklyAccounts.length) *
          10,
      ) / 10;
    grokPrimaryReset = [...grokWeeklyAccounts]
      .flatMap((account) => (account.resetsAt ? [account.resetsAt] : []))
      .sort()[0];
  }

  if (grokBuildAccounts.length > 0) {
    const buildReset = grokBuildAccounts.find((a) => a.resetsAt)?.resetsAt;
    const avgBuild =
      Math.round(
        (grokBuildAccounts.reduce((a, b) => a + b.usagePercent, 0) / grokBuildAccounts.length) * 10,
      ) / 10;
    productUsage.push({
      product: "Grok Build",
      usagePercent: avgBuild,
      ...(buildReset ? { resetsAt: buildReset } : {}),
      accounts: grokBuildAccounts,
    });
  } else if (grokWeeklyAccounts.length > 0) {
    const weeklyReset = grokWeeklyAccounts.find((a) => a.resetsAt)?.resetsAt;
    const avgWeekly =
      Math.round(
        (grokWeeklyAccounts.reduce((a, b) => a + b.usagePercent, 0) / grokWeeklyAccounts.length) *
          10,
      ) / 10;
    productUsage.push({
      product: "Grok (Weekly)",
      usagePercent: avgWeekly,
      ...(weeklyReset ? { resetsAt: weeklyReset } : {}),
      accounts: grokWeeklyAccounts,
    });
  }

  // 3. Codex (`codex`)
  let codexSessionUsed: number | null = null;
  let codexSessionReset: string | undefined;
  const codexSessionAccounts: AccountCreditsAccountUsage[] = [];
  const codexWeeklyAccounts: AccountCreditsAccountUsage[] = [];
  const codexConns = activeConnections.filter((c) => c.provider === "codex");

  for (const conn of codexConns) {
    const cache = data.caches[conn.id];
    const quotas = isRecord(cache?.quotas) ? cache.quotas : undefined;
    if (!quotas) continue;

    const session = parseQuotaUsedPercent(quotas.session ?? quotas["session (5h)"]);
    const weekly = parseQuotaUsedPercent(quotas.weekly ?? quotas["weekly (7d)"]);

    if (session) {
      codexSessionAccounts.push({
        accountName: connectionAccountName(conn),
        usagePercent: session.usedPercent,
        ...(session.resetsAt ? { resetsAt: session.resetsAt } : {}),
      });
    }
    if (weekly) {
      codexWeeklyAccounts.push({
        accountName: connectionAccountName(conn),
        usagePercent: weekly.usedPercent,
        ...(weekly.resetsAt ? { resetsAt: weekly.resetsAt } : {}),
      });
    }
  }

  if (codexSessionAccounts.length > 0) {
    const avgSession =
      Math.round(
        (codexSessionAccounts.reduce((a, b) => a + b.usagePercent, 0) /
          codexSessionAccounts.length) *
          10,
      ) / 10;
    codexSessionUsed = avgSession;
    codexSessionReset = [...codexSessionAccounts]
      .flatMap((account) => (account.resetsAt ? [account.resetsAt] : []))
      .sort()[0];
    productUsage.push({
      product: "Codex (5h)",
      usagePercent: avgSession,
      ...(codexSessionReset ? { resetsAt: codexSessionReset } : {}),
      accounts: codexSessionAccounts,
    });
  }
  if (codexWeeklyAccounts.length > 0) {
    const avgWeekly =
      Math.round(
        (codexWeeklyAccounts.reduce((a, b) => a + b.usagePercent, 0) / codexWeeklyAccounts.length) *
          10,
      ) / 10;
    const firstReset = codexWeeklyAccounts.find((a) => a.resetsAt)?.resetsAt;
    productUsage.push({
      product: "Codex (7d)",
      usagePercent: avgWeekly,
      ...(firstReset ? { resetsAt: firstReset } : {}),
      accounts: codexWeeklyAccounts,
    });
  }

  // 4. Claude direct connection
  let claudeDirectUsed: number | null = null;
  let claudeDirectReset: string | undefined;
  const claudeSessionAccounts: AccountCreditsAccountUsage[] = [];
  const claudeWeeklyAccounts: AccountCreditsAccountUsage[] = [];
  const claudeConns = activeConnections.filter(
    (c) => c.provider === "claude" || c.provider === "default_claude_max_5x",
  );

  for (const conn of claudeConns) {
    const cache = data.caches[conn.id];
    const quotas = isRecord(cache?.quotas) ? cache.quotas : undefined;
    if (!quotas) continue;

    const session = parseQuotaUsedPercent(quotas["session (5h)"] ?? quotas.session);
    const weekly = parseQuotaUsedPercent(quotas["weekly (7d)"] ?? quotas.weekly);

    if (session) {
      claudeDirectUsed = session.usedPercent;
      claudeDirectReset = session.resetsAt;
      claudeSessionAccounts.push({
        accountName: connectionAccountName(conn),
        usagePercent: session.usedPercent,
        ...(session.resetsAt ? { resetsAt: session.resetsAt } : {}),
      });
    }
    if (weekly) {
      if (claudeDirectUsed === null) {
        claudeDirectUsed = weekly.usedPercent;
        claudeDirectReset = weekly.resetsAt;
      }
      claudeWeeklyAccounts.push({
        accountName: connectionAccountName(conn),
        usagePercent: weekly.usedPercent,
        ...(weekly.resetsAt ? { resetsAt: weekly.resetsAt } : {}),
      });
    }
  }

  if (claudeSessionAccounts.length > 0) {
    const avgSession =
      Math.round(
        (claudeSessionAccounts.reduce((a, b) => a + b.usagePercent, 0) /
          claudeSessionAccounts.length) *
          10,
      ) / 10;
    productUsage.push({
      product: "Claude (5h)",
      usagePercent: avgSession,
      ...(claudeDirectReset ? { resetsAt: claudeDirectReset } : {}),
      accounts: claudeSessionAccounts,
    });
  }
  if (claudeWeeklyAccounts.length > 0) {
    const avgWeekly =
      Math.round(
        (claudeWeeklyAccounts.reduce((a, b) => a + b.usagePercent, 0) /
          claudeWeeklyAccounts.length) *
          10,
      ) / 10;
    const firstReset = claudeWeeklyAccounts.find((a) => a.resetsAt)?.resetsAt;
    productUsage.push({
      product: "Claude (7d)",
      usagePercent: avgWeekly,
      ...(firstReset ? { resetsAt: firstReset } : {}),
      accounts: claudeWeeklyAccounts,
    });
  }

  // 5. Any other active providers with cached quotas
  const handledProviders = new Set([
    "agy",
    "grok-cli",
    "grok",
    "codex",
    "claude",
    "default_claude_max_5x",
  ]);
  const otherConns = activeConnections.filter((c) => !handledProviders.has(c.provider));
  for (const conn of otherConns) {
    const cache = data.caches[conn.id];
    const quotas = isRecord(cache?.quotas) ? cache.quotas : undefined;
    if (!quotas) continue;

    for (const [quotaKey, quotaVal] of Object.entries(quotas)) {
      const parsed = parseQuotaUsedPercent(quotaVal);
      if (parsed) {
        const prodName = `${conn.provider} (${quotaKey})`;
        productUsage.push({
          product: prodName,
          usagePercent: parsed.usedPercent,
          ...(parsed.resetsAt ? { resetsAt: parsed.resetsAt } : {}),
          accounts: [
            {
              accountName: connectionAccountName(conn),
              usagePercent: parsed.usedPercent,
              ...(parsed.resetsAt ? { resetsAt: parsed.resetsAt } : {}),
            },
          ],
        });
      }
    }
  }

  // Determine primary period and usage
  let usedPercent: number;
  let periodType: AccountCreditsSnapshot["periodType"];
  let resetsAt: string | undefined;

  if (pooledFlashUsed !== null) {
    usedPercent = pooledFlashUsed;
    periodType = "five_hour";
    resetsAt = earliestFlashReset;
  } else if (grokPrimaryUsed !== null) {
    usedPercent = grokPrimaryUsed;
    periodType = "weekly";
    resetsAt = grokPrimaryReset;
  } else if (codexSessionUsed !== null) {
    usedPercent = codexSessionUsed;
    periodType = "five_hour";
    resetsAt = codexSessionReset;
  } else if (claudeDirectUsed !== null) {
    usedPercent = claudeDirectUsed;
    periodType = claudeDirectReset ? "five_hour" : "seven_day";
    resetsAt = claudeDirectReset;
  } else if (productUsage.length > 0) {
    const first = productUsage[0];
    if (!first) return null;
    usedPercent = first.usagePercent;
    periodType = "unknown";
    resetsAt = first.resetsAt;
  } else {
    return null;
  }

  return {
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    periodType,
    ...(resetsAt ? { resetsAt } : {}),
    ...(productUsage.length > 0 ? { productUsage } : {}),
  };
}

async function defaultQueryDatabase(dbPath: string): Promise<OmniRouteStorageData | null> {
  const DatabaseClass = await loadDatabaseSync();
  if (!DatabaseClass) return null;

  try {
    const db = new DatabaseClass(dbPath, { readOnly: true, open: true });
    try {
      const conns = db
        .prepare(
          "SELECT id, provider, is_active, email FROM provider_connections WHERE is_active = 1",
        )
        .all() as Array<{ id: string; provider: string; is_active: number; email: string | null }>;

      const rows = db
        .prepare("SELECT key, value FROM key_value WHERE namespace = 'providerLimitsCache'")
        .all() as Array<{ key: string; value: string }>;

      const caches: Record<string, OmniRouteCacheEntry> = {};
      for (const row of rows) {
        try {
          caches[row.key] = JSON.parse(row.value) as OmniRouteCacheEntry;
        } catch {
          // Ignore malformed JSON entries
        }
      }

      return {
        connections: conns.map((c) => ({
          id: c.id,
          provider: c.provider,
          isActive: Boolean(c.is_active),
          email: c.email,
        })),
        caches,
      };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export async function fetchOmpCredits(
  input: FetchOmpCreditsInput = {},
): Promise<AccountCreditsSnapshot | null> {
  try {
    const environment = input.environment ?? process.env;
    const dbPath = input.dbPath ?? defaultOmniRouteDbPath(environment);
    const queryDatabase = input.queryDatabase ?? defaultQueryDatabase;

    const data = await queryDatabase(dbPath);
    if (!data) return null;

    return parseOmniRouteCredits(data);
  } catch {
    return null;
  }
}
