import { runInstallationCommand } from "@codexhost/harness-discovery";
import {
  type AccountCreditsSnapshot,
  type HarnessAccountSnapshot,
} from "@codexhost/shared-contracts";
import { resolveOmpExecutable } from "./command.js";
import { activeOmpEntries, type OmpSessionHistory } from "./omp-history.js";

const CACHE_MS = 30_000;

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

/** One cache per OMP launch context; credential IDs are local to its profile. */
export class OmpAccountCredits {
  #cached: { fetchedAt: number; accounts: Map<string, HarnessAccountSnapshot> } | undefined;
  #pending: Promise<Map<string, HarnessAccountSnapshot>> | undefined;
  #probeSequence = 0;

  constructor(private readonly load: () => Promise<string>) {}

  async forAccount(key: string): Promise<AccountCreditsSnapshot | null> {
    return (await this.#read()).get(key)?.credits ?? null;
  }

  async inspectAccounts(): Promise<HarnessAccountSnapshot[]> {
    // The Host already caches settings reads and explicitly bypasses that cache on refresh.
    return [...(await this.#read(true)).values()];
  }

  #read(refresh = false): Promise<Map<string, HarnessAccountSnapshot>> {
    if (!refresh) {
      if (this.#pending) return this.#pending;
      if (this.#cached && Date.now() - this.#cached.fetchedAt < CACHE_MS)
        return Promise.resolve(this.#cached.accounts);
    }
    const sequence = ++this.#probeSequence;
    this.#pending = (async () => {
      const accounts = new Map<string, HarnessAccountSnapshot>();
      try {
        const data = object(JSON.parse(await this.load()));
        if (Array.isArray(data?.reports)) {
          const ambiguous = new Set<string>();
          for (const value of data.reports) {
            const report = object(value);
            const key = accountKey(report?.provider, object(report?.metadata)?.credentialId);
            if (!key || ambiguous.has(key)) continue;
            if (accounts.has(key)) {
              accounts.delete(key);
              ambiguous.add(key);
              continue;
            }
            const account = reportAccount(value);
            if (account) accounts.set(key, account);
          }
        }
      } catch {
        // Old CLI, missing credentials, or a failed probe: no quota, never another account's.
      }
      if (sequence === this.#probeSequence) this.#cached = { fetchedAt: Date.now(), accounts };
      return accounts;
    })().finally(() => {
      if (sequence === this.#probeSequence) this.#pending = undefined;
    });
    return this.#pending;
  }
}

export function createOmpAccountCredits(
  command: string | undefined,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
) {
  const env = { ...environment, OMP_SKIP_VERSION_CHECK: "1", OMP_TELEMETRY: "0" };
  return new OmpAccountCredits(() =>
    runInstallationCommand(
      resolveOmpExecutable({ ...(command ? { command } : {}), environment: env }),
      ["usage", "--json", "--no-extensions"],
      env,
      5_000,
      cwd,
    ),
  );
}
