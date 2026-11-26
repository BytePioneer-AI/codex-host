import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { runInstallationCommand } from "@codexhost/harness-discovery";
import {
  harnessIdSchema,
  type BillingSourceRef,
  type AccountCreditsSnapshot,
  type HarnessAccountSnapshot,
} from "@codexhost/shared-contracts";
import { resolveOmpExecutable } from "./command.js";
import { activeOmpEntries, type OmpSessionHistory } from "./omp-history.js";
import { listOmpBillingIdentities } from "./omp-billing-source-session.js";

const CACHE_MS = 30_000;
// The Host allows 12 s for inspection; the quota command already has its own 5 s budget.
const IDENTITY_BUDGET_MS = 5_000;
const ompHarnessId = harnessIdSchema.parse("omp");

type Window = Omit<AccountCreditsSnapshot, "productUsage" | "resetCredits">;

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function nonnegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function accountKey(provider: unknown, credentialId: unknown): string | null {
  return typeof provider === "string" &&
    provider.length > 0 &&
    typeof credentialId === "number" &&
    Number.isSafeInteger(credentialId) &&
    credentialId >= 0
    ? JSON.stringify([provider, credentialId])
    : null;
}

/** Partial assistant messages carry the credential selected for the current stream attempt. */
export function ompStreamingAccount(message: unknown): string | null | undefined {
  const data = object(message);
  if (data?.role !== "assistant" || data.stopReason === "error" || data.stopReason === "aborted")
    return undefined;
  return accountKey(data.provider, data.credentialId);
}

/** Undefined means not a completed model response; null means its account is unknown. */
export function ompMessageAccount(message: unknown): string | null | undefined {
  const data = object(message);
  if (
    data?.role !== "assistant" ||
    (data.stopReason !== "stop" && data.stopReason !== "toolUse" && data.stopReason !== "length")
  )
    return undefined;
  return accountKey(data.provider, data.credentialId);
}

export function latestOmpAccount(history: OmpSessionHistory): string | null {
  if (history.incomplete) return null;
  const entries = activeOmpEntries(history);
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type !== "message") continue;
    const key = ompMessageAccount(entry.message);
    if (key !== undefined) return key;
  }
  return null;
}

function quotaWindow(value: unknown): Window | null {
  const limit = object(value);
  const amount = object(limit?.amount);
  const used = nonnegative(amount?.used);
  const total = nonnegative(amount?.limit);
  const usedFraction = nonnegative(amount?.usedFraction);
  const remainingFraction = nonnegative(amount?.remainingFraction);
  const fraction =
    usedFraction ??
    (remainingFraction !== undefined && remainingFraction <= 1
      ? 1 - remainingFraction
      : undefined) ??
    (used !== undefined && total !== undefined && total > 0 ? used / total : undefined);
  if (fraction === undefined || !Number.isFinite(fraction)) return null;

  const window = object(limit?.window);
  const label = text(limit?.label) ?? text(window?.label);
  const resetsAt = nonnegative(window?.resetsAt);
  const duration = window?.durationMs;
  const unit = text(amount?.unit);
  return {
    usedPercent: Math.min(100, fraction * 100),
    periodType:
      duration === 18_000_000 ? "five_hour" : duration === 604_800_000 ? "seven_day" : "unknown",
    ...(label ? { label } : {}),
    ...(resetsAt !== undefined && resetsAt > 0 && resetsAt <= 8.64e15
      ? { resetsAt: new Date(resetsAt).toISOString() }
      : {}),
    ...(unit && unit !== "percent" && unit.length <= 32
      ? {
          unit,
          ...(used !== undefined ? { used } : {}),
          ...(total !== undefined ? { limit: total } : {}),
        }
      : {}),
  };
}

function reportAccount(value: unknown): HarnessAccountSnapshot | null {
  const report = object(value);
  if (!Array.isArray(report?.limits)) return null;
  const windows = report.limits.map(quotaWindow).filter((window) => window !== null);
  const primary = windows.find((window) => window.periodType === "five_hour") ?? windows[0];
  if (!primary) return null;
  const productUsage = windows
    .filter((window) => window !== primary)
    .map((window) => {
      const { label, usedPercent, ...rest } = window;
      return { ...rest, product: label ?? "Quota", usagePercent: usedPercent };
    });
  const metadata = object(report.metadata);
  const plan = text(metadata?.planType)?.slice(0, 128);
  const email = text(metadata?.email)?.slice(0, 320);
  const provider = text(report.provider)?.slice(0, 256);
  return {
    ...(provider ? { label: provider } : {}),
    ...(email ? { email } : {}),
    ...(plan ? { plan } : {}),
    credits: { ...primary, ...(productUsage.length ? { productUsage } : {}) },
  };
}

export interface OmpNativeBillingIdentity {
  provider: string;
  credentialId: number;
  identityKey: string;
}

export type OmpBillingTarget = OmpNativeBillingIdentity;

interface AccountRead {
  accounts: Map<string, HarnessAccountSnapshot>;
  identities: Map<string, string>;
}

/** One cache per OMP launch context; credential IDs are local to its profile. */
export class OmpAccountCredits {
  #cached: { fetchedAt: number; identified: boolean; value: AccountRead } | undefined;
  #pending: { identified: boolean; value: Promise<AccountRead> } | undefined;
  readonly #identityShutdown = new AbortController();
  readonly #identityProbes = new Set<Promise<readonly OmpNativeBillingIdentity[]>>();
  #probeSequence = 0;

  constructor(
    private readonly load: () => Promise<string>,
    private readonly profile = "",
    private readonly loadIdentities: (
      signal: AbortSignal,
    ) => Promise<readonly OmpNativeBillingIdentity[]> = async () => [],
  ) {}

  async forAccount(key: string): Promise<AccountCreditsSnapshot | null> {
    return (await this.#read()).accounts.get(key)?.credits ?? null;
  }

  async inspectAccounts(): Promise<HarnessAccountSnapshot[]> {
    // The Host already caches settings reads and explicitly bypasses that cache on refresh.
    return [...(await this.#read(true, true)).accounts.values()];
  }

  async resolve(ref: BillingSourceRef): Promise<OmpBillingTarget | null> {
    if (ref.harnessId !== ompHarnessId) return null;
    const { accounts, identities } = await this.#read(true, true);
    for (const [key, account] of accounts) {
      if (account.billingSourceRef?.id !== ref.id) continue;
      const identityKey = identities.get(key);
      if (!identityKey) return null;
      const [provider, credentialId] = JSON.parse(key) as [string, number];
      return { provider, credentialId, identityKey };
    }
    return null;
  }

  async close(): Promise<void> {
    this.#identityShutdown.abort();
    await Promise.allSettled(this.#identityProbes);
  }

  async #readIdentities(): Promise<readonly OmpNativeBillingIdentity[]> {
    const shutdown = this.#identityShutdown.signal;
    if (shutdown.aborted) return [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IDENTITY_BUDGET_MS);
    const signal = AbortSignal.any([shutdown, controller.signal]);
    let probe: Promise<readonly OmpNativeBillingIdentity[]> | undefined;
    try {
      probe = this.loadIdentities(signal);
      this.#identityProbes.add(probe);
      const rows = await probe;
      return signal.aborted ? [] : rows;
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
      if (probe) this.#identityProbes.delete(probe);
    }
  }

  #read(refresh = false, identified = false): Promise<AccountRead> {
    if (!refresh) {
      if (this.#pending && (this.#pending.identified || !identified)) return this.#pending.value;
      if (
        this.#cached &&
        Date.now() - this.#cached.fetchedAt < CACHE_MS &&
        (this.#cached.identified || !identified)
      )
        return Promise.resolve(this.#cached.value);
    }
    const sequence = ++this.#probeSequence;
    const operation = (async (): Promise<AccountRead> => {
      const accounts = new Map<string, HarnessAccountSnapshot>();
      const identities = new Map<string, string>();
      try {
        const data = object(JSON.parse(await this.load()));
        const nativeIdentities = new Map<string, string | null>();
        const uniqueIdentities = new Map<string, boolean>();
        if (identified) {
          for (const row of await this.#readIdentities()) {
            const key = accountKey(row.provider, row.credentialId);
            const identityKey = text(row.identityKey);
            if (!key || !identityKey) continue;
            nativeIdentities.set(key, nativeIdentities.has(key) ? null : identityKey);
            const identity = JSON.stringify([row.provider, identityKey]);
            uniqueIdentities.set(identity, !uniqueIdentities.has(identity));
          }
        }
        if (Array.isArray(data?.reports)) {
          const ambiguous = new Set<string>();
          for (const value of data.reports) {
            const report = object(value);
            const metadata = object(report?.metadata);
            const key = accountKey(report?.provider, metadata?.credentialId);
            if (!key || ambiguous.has(key)) continue;
            if (accounts.has(key)) {
              accounts.delete(key);
              ambiguous.add(key);
              continue;
            }
            const account = reportAccount(value);
            if (!account) continue;
            const identityKey = nativeIdentities.get(key);
            const reportedIdentity = text(metadata?.identityKey);
            const provider = report?.provider;
            let billingSourceRef: BillingSourceRef | undefined;
            if (
              identityKey &&
              typeof provider === "string" &&
              reportedIdentity === identityKey &&
              uniqueIdentities.get(JSON.stringify([provider, identityKey]))
            ) {
              identities.set(key, identityKey);
              const id = createHash("sha256")
                .update(this.profile)
                .update("\0")
                .update(provider)
                .update("\0")
                .update(identityKey)
                .digest("base64url");
              billingSourceRef = { harnessId: ompHarnessId, id };
            }
            accounts.set(key, { ...account, ...(billingSourceRef ? { billingSourceRef } : {}) });
          }
        }
      } catch {
        // Old CLI, missing credentials, or a failed probe: no quota, never another account's.
      }
      const result = { accounts, identities };
      if (sequence === this.#probeSequence)
        this.#cached = { fetchedAt: Date.now(), identified, value: result };
      return result;
    })();
    const value = operation.finally(() => {
      if (sequence === this.#probeSequence) this.#pending = undefined;
    });
    this.#pending = { identified, value };
    return value;
  }
}

export function createOmpAccountCredits(
  command: string | undefined,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
) {
  const env = { ...environment, OMP_SKIP_VERSION_CHECK: "1", OMP_TELEMETRY: "0" };
  const home =
    (process.platform === "win32" ? environment.USERPROFILE : environment.HOME) || homedir();
  const profile = path.resolve(
    cwd ?? process.cwd(),
    environment.PI_CODING_AGENT_DIR || path.join(home, ".omp", "agent"),
  );
  return new OmpAccountCredits(
    () =>
      runInstallationCommand(
        resolveOmpExecutable({ ...(command ? { command } : {}), environment: env }),
        ["usage", "--json", "--no-extensions"],
        env,
        5_000,
        cwd,
      ),
    profile,
    (signal) =>
      listOmpBillingIdentities(
        {
          cwd: cwd ?? process.cwd(),
          environment: env,
          ...(command ? { command } : {}),
        },
        signal,
      ),
  );
}
