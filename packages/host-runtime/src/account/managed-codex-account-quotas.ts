import { z } from "zod";

import {
  accountCreditsSnapshotSchema,
  type AccountCreditsSnapshot,
  type CodexAccountUsageResult,
} from "@codexhost/shared-contracts";
import { privateFileDigest } from "../native-private-files.js";
import type { CredentialFileAccess, CodexCredentialFiles } from "./codex-credential-files.js";
import type { NativeCodexCredentials } from "./native-codex-credentials.js";
import type { SavedCodexAccount } from "./saved-codex-accounts.js";

const QUOTA_CACHE_FILE = "codex-quota-cache.json";
const QUOTA_CACHE_TTL_MS = 5 * 60_000;
const QUOTA_DISK_MAX_AGE_MS = 6 * 60 * 60_000;
const QUOTA_REQUEST_TIMEOUT_MS = 8_000;
const MAX_QUOTA_RESPONSE_BYTES = 1024 * 1024;
const MAX_TOKEN_RESPONSE_BYTES = 256 * 1024;
const CHATGPT_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const WHAM_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

const quotaSnapshotSchema = z
  .object({
    accountCredits: accountCreditsSnapshotSchema,
    observedAt: z.string().datetime(),
  })
  .strict();
const quotaCacheSchema = z
  .object({
    version: z.literal(1),
    snapshots: z.record(z.string().uuid(), quotaSnapshotSchema),
  })
  .strict();
type QuotaSnapshot = z.infer<typeof quotaSnapshotSchema>;

type Fetch = typeof fetch;

export class CodexAccountQuotaError extends Error {
  constructor(readonly code: "authentication" | "unavailable" | "invalid-response") {
    super(`Codex Account quota ${code}`);
    this.name = "CodexAccountQuotaError";
  }
}

class BoundedConcurrency {
  #active = 0;
  readonly #waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#active >= this.limit)
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    this.#active++;
    try {
      return await operation();
    } finally {
      this.#active--;
      this.#waiters.shift()?.();
    }
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | undefined {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(numeric) ? numeric : undefined;
}

function percent(value: unknown): number | undefined {
  const numeric = finiteNumber(value);
  return numeric === undefined ? undefined : Math.min(100, Math.max(0, numeric));
}

function nonNegative(value: unknown): number | undefined {
  const numeric = finiteNumber(value);
  return numeric !== undefined && numeric >= 0 ? numeric : undefined;
}

function resetIso(value: unknown): string | undefined {
  const seconds = nonNegative(value);
  if (seconds === undefined) return undefined;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

interface UsageWindow {
  usedPercent: number;
  resetsAt?: string;
  durationSeconds?: number;
}

function usageWindow(value: unknown): UsageWindow | null {
  const source = record(value);
  if (!source) return null;
  const usedPercent = percent(source.used_percent);
  if (usedPercent === undefined) return null;
  const resetsAt = resetIso(source.reset_at);
  const durationSeconds = nonNegative(source.limit_window_seconds);
  return {
    usedPercent,
    ...(resetsAt ? { resetsAt } : {}),
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
  };
}

function periodFor(window: UsageWindow): AccountCreditsSnapshot["periodType"] {
  const seconds = window.durationSeconds;
  if (seconds === undefined) return "unknown";
  if (seconds > 0 && seconds < 24 * 60 * 60) return "five_hour";
  if (seconds >= 28 * 24 * 60 * 60) return "monthly";
  if (seconds >= 6 * 24 * 60 * 60 && seconds <= 8 * 24 * 60 * 60) return "seven_day";
  return "weekly";
}

function periodLabel(period: AccountCreditsSnapshot["periodType"]): string {
  if (period === "five_hour") return "5-hour window";
  if (period === "seven_day") return "7-day window";
  if (period === "monthly") return "Monthly window";
  if (period === "weekly") return "Weekly window";
  return "Additional window";
}

/** Parse only the bounded quota fields exposed to Renderer; raw upstream data is discarded. */
export function parseWhamAccountCredits(value: unknown): AccountCreditsSnapshot | null {
  const root = record(value);
  const limits = record(root?.rate_limit);
  const ordinary = [
    usageWindow(limits?.primary_window),
    usageWindow(limits?.secondary_window),
    usageWindow(limits?.tertiary_window),
  ].filter((window): window is UsageWindow => window !== null);
  const primary = ordinary[0];
  if (!primary) return null;

  const productUsage: NonNullable<AccountCreditsSnapshot["productUsage"]> = [];
  for (const window of ordinary.slice(1)) {
    productUsage.push({
      product: periodLabel(periodFor(window)),
      usagePercent: window.usedPercent,
      ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
    });
  }

  const additional = Array.isArray(root?.additional_rate_limits)
    ? root.additional_rate_limits.slice(0, 32)
    : [];
  for (const entryValue of additional) {
    const entry = record(entryValue);
    const rateLimit = record(entry?.rate_limit);
    const labelValue = entry?.limit_name ?? entry?.metered_feature;
    const label =
      typeof labelValue === "string" && labelValue.trim()
        ? labelValue.trim().slice(0, 256)
        : "Additional limit";
    for (const candidate of [
      usageWindow(rateLimit?.primary_window),
      usageWindow(rateLimit?.secondary_window),
    ]) {
      if (!candidate) continue;
      productUsage.push({
        product: label,
        usagePercent: candidate.usedPercent,
        ...(candidate.resetsAt ? { resetsAt: candidate.resetsAt } : {}),
      });
      if (productUsage.length >= 32) break;
    }
    if (productUsage.length >= 32) break;
  }

  const resetCreditsSource = record(root?.rate_limit_reset_credits);
  const availableCount = nonNegative(resetCreditsSource?.available_count);
  const resetCredits =
    availableCount !== undefined && Number.isSafeInteger(availableCount) && availableCount > 0
      ? { availableCount }
      : undefined;
  return accountCreditsSnapshotSchema.parse({
    usedPercent: primary.usedPercent,
    periodType: periodFor(primary),
    ...(primary.resetsAt ? { resetsAt: primary.resetsAt } : {}),
    ...(productUsage.length > 0 ? { productUsage } : {}),
    ...(resetCredits ? { resetCredits } : {}),
  });
}

function mergeAccountCredits(
  previous: AccountCreditsSnapshot | undefined,
  incoming: AccountCreditsSnapshot,
  clearMissingResetCredits = false,
): AccountCreditsSnapshot {
  if (!previous) return incoming;
  const incomingProducts = new Map(
    (incoming.productUsage ?? []).map((product) => [product.product, product]),
  );
  const productUsage = [
    ...(incoming.productUsage ?? []),
    ...(previous.productUsage ?? []).filter((product) => !incomingProducts.has(product.product)),
  ];
  return accountCreditsSnapshotSchema.parse({
    ...incoming,
    ...(productUsage.length > 0 ? { productUsage } : {}),
    ...(!clearMissingResetCredits && (incoming.resetCredits ?? previous.resetCredits)
      ? { resetCredits: incoming.resetCredits ?? previous.resetCredits }
      : incoming.resetCredits
        ? { resetCredits: incoming.resetCredits }
        : {}),
  });
}

async function boundedJson(response: Response, limit: number): Promise<unknown> {
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > limit) throw new CodexAccountQuotaError("invalid-response");
  try {
    return JSON.parse(text);
  } catch {
    throw new CodexAccountQuotaError("invalid-response");
  }
}

/**
 * OpenCodex-style per-account quota reader. It never installs a credential into CODEX_HOME and
 * never starts an official backend. Only inactive credential slots may be refreshed here.
 */
export class ManagedCodexAccountQuotas {
  readonly #files: CredentialFileAccess;
  readonly #directory: string;
  readonly #credentials: CodexCredentialFiles;
  readonly #fetch: Fetch;
  readonly #admitCredentialRefresh: (accountId: string) => () => void;
  readonly #concurrency = new BoundedConcurrency(4);
  readonly #quotaFlights = new Map<string, Promise<CodexAccountUsageResult>>();
  readonly #refreshFlights = new Map<string, Promise<NativeCodexCredentials>>();
  readonly #snapshots = new Map<string, QuotaSnapshot>();
  #cacheBytes: Buffer | null = null;
  #mutations: Promise<void> = Promise.resolve();

  constructor(input: {
    files: CredentialFileAccess;
    directory: string;
    credentials: CodexCredentialFiles;
    fetch?: Fetch;
    admitCredentialRefresh?: (accountId: string) => () => void;
  }) {
    this.#files = input.files;
    this.#directory = input.directory;
    this.#credentials = input.credentials;
    this.#fetch = input.fetch ?? fetch;
    this.#admitCredentialRefresh = input.admitCredentialRefresh ?? (() => () => undefined);
  }

  async initialize(liveAccountIds: ReadonlySet<string>): Promise<void> {
    await this.#files.ensureDirectory(this.#directory);
    this.#cacheBytes = await this.#files.read(this.#directory, QUOTA_CACHE_FILE);
    if (!this.#cacheBytes) return;
    try {
      const parsed = quotaCacheSchema.parse(JSON.parse(this.#cacheBytes.toString("utf8")));
      const now = Date.now();
      for (const [accountId, snapshot] of Object.entries(parsed.snapshots)) {
        if (!liveAccountIds.has(accountId)) continue;
        if (now - Date.parse(snapshot.observedAt) > QUOTA_DISK_MAX_AGE_MS) continue;
        this.#snapshots.set(accountId, snapshot);
      }
    } catch {
      // A corrupt best-effort quota cache must not block Account switching or native Codex.
    }
  }

  get(accountId: string): CodexAccountUsageResult | null {
    const snapshot = this.#snapshots.get(accountId);
    return snapshot
      ? {
          accountId,
          usage: null,
          accountCredits: structuredClone(snapshot.accountCredits),
          freshness: "cached",
          observedAt: snapshot.observedAt,
        }
      : null;
  }

  inspect(account: SavedCodexAccount, forceRefresh = false): Promise<CodexAccountUsageResult> {
    const cached = this.#snapshots.get(account.accountId);
    if (
      !forceRefresh &&
      cached &&
      Date.now() - Date.parse(cached.observedAt) < QUOTA_CACHE_TTL_MS
    ) {
      return Promise.resolve({
        accountId: account.accountId,
        usage: null,
        accountCredits: structuredClone(cached.accountCredits),
        freshness: "cached",
        observedAt: cached.observedAt,
      });
    }
    const active = this.#quotaFlights.get(account.accountId);
    if (active) return active;
    const flight = this.#concurrency
      .run(() => this.#readLive(account))
      .finally(() => {
        if (this.#quotaFlights.get(account.accountId) === flight) {
          this.#quotaFlights.delete(account.accountId);
        }
      });
    this.#quotaFlights.set(account.accountId, flight);
    return flight;
  }

  async record(
    accountId: string,
    accountCredits: AccountCreditsSnapshot,
    options: { clearMissingResetCredits?: boolean } = {},
  ): Promise<CodexAccountUsageResult> {
    const snapshot = quotaSnapshotSchema.parse({
      accountCredits: mergeAccountCredits(
        this.#snapshots.get(accountId)?.accountCredits,
        accountCredits,
        options.clearMissingResetCredits === true,
      ),
      observedAt: new Date().toISOString(),
    });
    this.#snapshots.set(accountId, snapshot);
    await this.#persist().catch(() => undefined);
    return {
      accountId,
      usage: null,
      accountCredits: structuredClone(snapshot.accountCredits),
      freshness: "live",
      observedAt: snapshot.observedAt,
    };
  }

  async remove(accountId: string): Promise<void> {
    if (!this.#snapshots.delete(accountId)) return;
    await this.#persist().catch(() => undefined);
  }

  async #readLive(account: SavedCodexAccount): Promise<CodexAccountUsageResult> {
    const previous = this.get(account.accountId);
    try {
      let credential = await this.#credentials.load(account);
      let refreshed = false;
      const oauth = credential.managedOAuthCredential();
      if (oauth.expiresAtUnix !== undefined && oauth.expiresAtUnix <= Date.now() / 1000 + 60) {
        credential = await this.#refreshCredential(account, credential);
        refreshed = true;
      }
      let response = await this.#requestUsage(credential.managedOAuthCredential());
      if (response.status === 401 && !refreshed) {
        credential = await this.#refreshCredential(account, credential);
        response = await this.#requestUsage(credential.managedOAuthCredential());
      }
      if (!response.ok) throw new CodexAccountQuotaError("unavailable");
      const payload = await boundedJson(response, MAX_QUOTA_RESPONSE_BYTES);
      const accountCredits = parseWhamAccountCredits(payload);
      if (!accountCredits) {
        if (previous) return previous;
        return {
          accountId: account.accountId,
          usage: null,
          freshness: "live",
          observedAt: new Date().toISOString(),
        };
      }
      const resetSummary = record(record(payload)?.rate_limit_reset_credits);
      return await this.record(account.accountId, accountCredits, {
        clearMissingResetCredits: nonNegative(resetSummary?.available_count) === 0,
      });
    } catch {
      if (previous) return previous;
      throw new CodexAccountQuotaError("unavailable");
    }
  }

  #requestUsage(credential: { accessToken: string; chatgptAccountId: string }): Promise<Response> {
    return this.#fetch(WHAM_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        "ChatGPT-Account-Id": credential.chatgptAccountId,
      },
      signal: AbortSignal.timeout(QUOTA_REQUEST_TIMEOUT_MS),
    });
  }

  #refreshCredential(
    account: SavedCodexAccount,
    expected: NativeCodexCredentials,
  ): Promise<NativeCodexCredentials> {
    const active = this.#refreshFlights.get(account.accountId);
    if (active) return active;
    const release = this.#admitCredentialRefresh(account.accountId);
    const flight = this.#performRefresh(account, expected).finally(() => {
      release();
      if (this.#refreshFlights.get(account.accountId) === flight) {
        this.#refreshFlights.delete(account.accountId);
      }
    });
    this.#refreshFlights.set(account.accountId, flight);
    return flight;
  }

  async #performRefresh(
    account: SavedCodexAccount,
    expected: NativeCodexCredentials,
  ): Promise<NativeCodexCredentials> {
    const oauth = expected.managedOAuthCredential();
    const response = await this.#fetch(CHATGPT_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CHATGPT_CLIENT_ID,
        refresh_token: oauth.refreshToken,
      }).toString(),
      signal: AbortSignal.timeout(QUOTA_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new CodexAccountQuotaError("authentication");
    const body = record(await boundedJson(response, MAX_TOKEN_RESPONSE_BYTES));
    if (!body || typeof body.access_token !== "string" || !body.access_token) {
      throw new CodexAccountQuotaError("invalid-response");
    }
    const refreshed = expected.withRefreshedOAuthTokens({
      accessToken: body.access_token,
      ...(typeof body.refresh_token === "string" && body.refresh_token
        ? { refreshToken: body.refresh_token }
        : {}),
    });
    await this.#credentials.replaceSaved(account, expected, refreshed);
    return refreshed;
  }

  #persist(): Promise<void> {
    const pending = this.#mutations.then(async () => {
      const snapshots = Object.fromEntries(
        [...this.#snapshots.entries()].map(([accountId, snapshot]) => [
          accountId,
          structuredClone(snapshot),
        ]),
      );
      const content = Buffer.from(`${JSON.stringify({ version: 1, snapshots })}\n`);
      const expected = this.#cacheBytes ? privateFileDigest(this.#cacheBytes) : null;
      await this.#files.replace(this.#directory, QUOTA_CACHE_FILE, content, expected);
      this.#cacheBytes = content;
    });
    this.#mutations = pending.catch(() => undefined);
    return pending;
  }
}
