import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";

import {
  harnessAccountSnapshotSchema,
  type AccountBalanceSnapshot,
  type HarnessAccountSnapshot,
} from "@codexhost/shared-contracts";

/**
 * DSH's DeepSeek provider authenticates with one API key. DeepSeek publishes the
 * key's prepaid balance; the key is sent only to DeepSeek's own balance endpoint.
 */
export const DEEPSEEK_BALANCE_ENDPOINT = "https://api.deepseek.com/user/balance";
const DEEPSEEK_API_KEY_REF = "DEEPSEEK_API_KEY";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BALANCE_ACCOUNTS = 4;

function dshHome(environment: NodeJS.ProcessEnv): string {
  const configured = environment.DSH_HOME?.trim();
  if (configured) return configured;
  return path.join(environment.HOME || environment.USERPROFILE || os.homedir(), ".dsh");
}

function unquote(value: string): string {
  const trimmed = value.trim();
  // A quoted value may be followed by a comment: `"sk-…" # primary`.
  const quoted = /^(["'])(.*?)\1\s*(?:#.*)?$/u.exec(trimmed);
  if (quoted) return (quoted[2] ?? "").trim();
  return trimmed.replace(/(?:^|\s+)#.*$/u, "").trim();
}

/** `refs.<name>` of a `version: 1` credentials document, or a legacy flat entry. */
export function readCredentialRef(text: string, name: string): string | undefined {
  const lines = text.split(/\r?\n/u);
  const entry = new RegExp(`^(\\s*)${name}\\s*:(.*)$`, "u");
  let inRefs = false;
  let refsIndent = -1;
  const versioned = lines.some((line) => /^version\s*:/u.test(line));
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      inRefs = /^refs\s*:\s*(?:#.*)?$/u.test(line);
      refsIndent = -1;
      if (!versioned) {
        const flat = entry.exec(line);
        if (flat) return unquote(flat[2] ?? "") || undefined;
      }
      continue;
    }
    if (!inRefs) continue;
    if (refsIndent === -1) refsIndent = indent;
    if (indent !== refsIndent) continue;
    const match = entry.exec(line);
    if (match) return unquote(match[2] ?? "") || undefined;
  }
  return undefined;
}

async function readOptional(file: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    signal?.throwIfAborted();
    // Credential sources are files, not devices or pipes that can wait indefinitely.
    if (!(await stat(file)).isFile()) throw new Error("Expected a regular DSH configuration file");
    return await readFile(file, { encoding: "utf8", ...(signal ? { signal } : {}) });
  } catch (error) {
    // Missing files are normal; a file we cannot read is not an authoritative absence.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Resolve the standard API-key reference only for the public API. */
export async function readDeepSeekApiKey(
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const home = dshHome(environment);
  const dotEnv = parseEnv((await readOptional(path.join(home, ".env"), signal)) ?? "");
  const baseUrl = environment.DEEPSEEK_BASE_URL ?? dotEnv.DEEPSEEK_BASE_URL;
  if (baseUrl !== undefined) {
    const endpoint = URL.parse(baseUrl);
    if (
      endpoint?.protocol !== "https:" ||
      endpoint.origin !== new URL(DEEPSEEK_BALANCE_ENDPOINT).origin
    ) {
      return undefined;
    }
  }
  // DSH applies these patches after the built-in Web profile. They can change both the
  // endpoint and credential reference; don't evaluate arbitrary DSH configuration here.
  for (const directory of [home, path.join(home, "profiles", "web")]) {
    const patch = await readOptional(path.join(directory, "cordis.patch.yml"), signal);
    if (patch !== undefined && patch.trim() !== "[]") return undefined;
  }
  const credentials = await readOptional(path.join(home, ".credentials.yaml"), signal);
  const fromCredentials = credentials
    ? readCredentialRef(credentials, DEEPSEEK_API_KEY_REF)
    : undefined;
  return (
    fromCredentials ||
    environment[DEEPSEEK_API_KEY_REF]?.trim() ||
    dotEnv[DEEPSEEK_API_KEY_REF]?.trim() ||
    undefined
  );
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function finiteAmount(value: unknown): number | null {
  const amount =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

/**
 * DeepSeek reports one entry per currency. Currencies holding funds are listed;
 * when every entry is empty the first one is kept so an exhausted key still shows 0.
 */
export function projectDeepSeekBalances(payload: unknown): HarnessAccountSnapshot[] {
  const data = record(payload);
  if (!Array.isArray(data.balance_infos)) return [];
  const entries = data.balance_infos.flatMap((value) => {
    const info = record(value);
    const amount = finiteAmount(info.total_balance);
    const currency = typeof info.currency === "string" ? info.currency.trim() : "";
    return amount === null || !currency ? [] : [{ amount, currency }];
  });
  const funded = entries.filter((entry) => entry.amount > 0);
  const shown = (funded.length > 0 ? funded : entries.slice(0, 1)).slice(0, MAX_BALANCE_ACCOUNTS);
  return shown.flatMap(({ amount, currency }) => {
    const parsed = harnessAccountSnapshotSchema.safeParse({
      label: shown.length > 1 ? `DeepSeek API (${currency})` : "DeepSeek API",
      balance: { amount, currency, label: "DeepSeek API" },
    });
    return parsed.success ? [parsed.data] : [];
  });
}

/** Fresh DeepSeek balance for the key DSH uses. Every failure yields no rows. */
export async function fetchDeepSeekBalances(
  input: {
    environment?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    fetch?: typeof fetch;
    readApiKey?: () => Promise<string | undefined>;
  } = {},
): Promise<HarnessAccountSnapshot[]> {
  try {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    signal.throwIfAborted();
    const environment = input.environment ?? process.env;
    const key = await (input.readApiKey
      ? input.readApiKey()
      : readDeepSeekApiKey(environment, signal));
    if (!key) return [];
    signal.throwIfAborted();
    const response = await (input.fetch ?? fetch)(DEEPSEEK_BALANCE_ENDPOINT, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return [];
    }
    const payload: unknown = await response.json();
    signal.throwIfAborted();
    return projectDeepSeekBalances(payload);
  } catch {
    return [];
  }
}

const BALANCE_REFRESH_INTERVAL_MS = 30_000;

/**
 * Composer-facing cache over {@link fetchDeepSeekBalances}: synchronous reads, one request in
 * flight, and at most one refresh per interval. A failed read clears the value so an
 * invalidated or removed key never keeps showing an old balance.
 */
export class DeepSeekBalanceCache {
  #value: AccountBalanceSnapshot | null = null;
  #fetchedAt = Number.NEGATIVE_INFINITY;
  #flight: Promise<readonly HarnessAccountSnapshot[]> | undefined;
  #closed = false;

  constructor(
    private readonly fetchBalances: () => Promise<readonly HarnessAccountSnapshot[]>,
    private readonly now: () => number = Date.now,
    private readonly intervalMs = BALANCE_REFRESH_INTERVAL_MS,
  ) {}

  read(): AccountBalanceSnapshot | null {
    return this.#closed ? null : this.#value;
  }

  /** Fresh rows for the settings page; also updates the composer value. */
  inspect(): Promise<readonly HarnessAccountSnapshot[]> {
    if (this.#closed) return Promise.resolve([]);
    this.#flight ??= this.fetchBalances()
      .catch(() => [] as readonly HarnessAccountSnapshot[])
      .then((accounts) => {
        // A result that arrives after close belongs to no one.
        if (this.#closed) return [];
        this.#value = accounts[0]?.balance ?? null;
        this.#fetchedAt = this.now();
        return accounts;
      })
      .finally(() => {
        this.#flight = undefined;
      });
    return this.#flight;
  }

  async refresh(): Promise<AccountBalanceSnapshot | null> {
    if (this.#closed) return null;
    if (!this.#flight && this.now() - this.#fetchedAt < this.intervalMs) return this.#value;
    await this.inspect();
    return this.read();
  }

  close(): void {
    this.#closed = true;
    this.#value = null;
  }
}
