import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  harnessAccountSnapshotSchema,
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

function readDotEnv(text: string, name: string): string | undefined {
  for (const line of text.split(/\r?\n/u)) {
    const match = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=(.*)$`, "u").exec(line);
    if (match) return unquote(match[1] ?? "") || undefined;
  }
  return undefined;
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

/** Same precedence as DSH: `.credentials.yaml`, then the process environment, then `.env`. */
export async function readDeepSeekApiKey(
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const home = dshHome(environment);
  const credentials = await readOptional(path.join(home, ".credentials.yaml"));
  const fromCredentials = credentials
    ? readCredentialRef(credentials, DEEPSEEK_API_KEY_REF)
    : undefined;
  if (fromCredentials) return fromCredentials;
  const fromEnvironment = environment[DEEPSEEK_API_KEY_REF]?.trim();
  if (fromEnvironment) return fromEnvironment;
  const dotEnv = await readOptional(path.join(home, ".env"));
  return dotEnv ? readDotEnv(dotEnv, DEEPSEEK_API_KEY_REF) : undefined;
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
    const environment = input.environment ?? process.env;
    const key = await (input.readApiKey ? input.readApiKey() : readDeepSeekApiKey(environment));
    if (!key) return [];
    const signal = input.signal
      ? AbortSignal.any([input.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await (input.fetch ?? fetch)(DEEPSEEK_BALANCE_ENDPOINT, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      redirect: "error",
      signal,
    });
    if (!response.ok) return [];
    return projectDeepSeekBalances(await response.json());
  } catch {
    return [];
  }
}
