import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import {
  harnessAccountSnapshotSchema,
  type HarnessAccountSnapshot,
} from "@codexhost/shared-contracts";

/**
 * Pi authenticates each provider separately. DeepSeek publishes a prepaid
 * balance. A custom Provider with an API key is asked for a sub2api wallet
 * balance at that Provider's own origin; the key is not sent anywhere else.
 */
const DEEPSEEK_BALANCE_ENDPOINT = "https://api.deepseek.com/user/balance";
const SUB2API_USAGE_PATH = "/v1/usage";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_PI_ACCOUNTS = 8;

function agentDirectory(environment: NodeJS.ProcessEnv): string {
  const configured = environment.PI_CODING_AGENT_DIR?.trim();
  if (configured) return configured;
  return path.join(environment.HOME ?? environment.USERPROFILE ?? homedir(), ".pi", "agent");
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

async function deepSeekApiKey(environment: NodeJS.ProcessEnv): Promise<string | undefined> {
  const auth = record(
    JSON.parse(await readFile(path.join(agentDirectory(environment), "auth.json"), "utf8")),
  );
  const deepseek = record(auth.deepseek);
  if (deepseek.type !== "api_key") return undefined;
  return typeof deepseek.key === "string" && deepseek.key.trim() ? deepseek.key : undefined;
}

/** sub2api `GET /v1/usage` wallet or key quota. Unlimited subscriptions are omitted. */
export function projectSub2ApiUsage(
  payload: unknown,
  providerId: string,
): HarnessAccountSnapshot | null {
  const data = record(payload);
  if (data.isValid === false) return null;
  if (data.mode !== "unrestricted" && data.mode !== "quota_limited") return null;
  const currency = typeof data.unit === "string" ? data.unit.trim() : "";
  if (!/^[A-Z]{3}$/u.test(currency)) return null;
  const wallet = finiteAmount(data.balance);
  const remaining = finiteAmount(data.remaining);
  const quotaRemaining = finiteAmount(record(data.quota).remaining);
  const amount = wallet ?? remaining ?? quotaRemaining;
  if (amount === null) return null;
  const planName = typeof data.planName === "string" ? data.planName.trim() : "";
  const label = providerId.trim();
  if (!label || label.length > 128) return null;
  const parsed = harnessAccountSnapshotSchema.safeParse({
    label,
    ...(planName ? { plan: planName.slice(0, 128) } : {}),
    balance: { amount, currency, label: planName || label },
  });
  return parsed.success ? parsed.data : null;
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

/** DeepSeek reports one entry per currency. Only the first is projected. */
export function projectDeepSeekBalance(payload: unknown): HarnessAccountSnapshot | null {
  const data = record(payload);
  if (!Array.isArray(data.balance_infos)) return null;
  const first = record(data.balance_infos[0]);
  const amount = finiteAmount(first.total_balance);
  const currency = typeof first.currency === "string" ? first.currency.trim() : "";
  if (amount === null || !currency) return null;
  const parsed = harnessAccountSnapshotSchema.safeParse({
    label: "DeepSeek",
    balance: { amount, currency, label: "DeepSeek API" },
  });
  return parsed.success ? parsed.data : null;
}

interface Sub2ApiProviderKey {
  readonly id: string;
  readonly apiKey: string;
  readonly baseUrl: string;
}

function usageEndpoint(baseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname) return null;
  url.username = "";
  url.password = "";
  url.pathname = SUB2API_USAGE_PATH;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function configuredSub2ApiProviders(
  environment: NodeJS.ProcessEnv,
): Promise<Sub2ApiProviderKey[]> {
  try {
    const models = record(
      JSON.parse(await readFile(path.join(agentDirectory(environment), "models.json"), "utf8")),
    );
    const providers = record(models.providers);
    const found: Sub2ApiProviderKey[] = [];
    for (const [id, definition] of Object.entries(providers)) {
      const provider = record(definition);
      const apiKey = typeof provider.apiKey === "string" ? provider.apiKey.trim() : "";
      const baseUrl = typeof provider.baseUrl === "string" ? provider.baseUrl.trim() : "";
      if (!id.trim() || id.length > 128 || !apiKey || !usageEndpoint(baseUrl)) continue;
      found.push({ id, apiKey, baseUrl });
    }
    return found.sort((left, right) => left.id.localeCompare(right.id));
  } catch {
    return [];
  }
}

async function fetchSub2ApiBalance(
  provider: Sub2ApiProviderKey,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<HarnessAccountSnapshot | null> {
  const endpoint = usageEndpoint(provider.baseUrl);
  if (!endpoint) return null;
  const response = await fetchImpl(endpoint, {
    headers: { Authorization: `Bearer ${provider.apiKey}`, Accept: "application/json" },
    redirect: "error",
    signal,
  });
  if (!response.ok) return null;
  return projectSub2ApiUsage(await response.json(), provider.id);
}

/** Every configured prepaid balance Pi can read. Failures omit that source only. */
export async function fetchPiAccounts(
  input: {
    environment?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    fetch?: typeof fetch;
    readApiKey?: () => Promise<string | undefined>;
    readProviders?: () => Promise<readonly Sub2ApiProviderKey[]>;
  } = {},
): Promise<HarnessAccountSnapshot[]> {
  try {
    const environment = input.environment ?? process.env;
    const fetchImpl = input.fetch ?? fetch;
    const signal = input.signal
      ? AbortSignal.any([input.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const [providers, deepseek] = await Promise.all([
      input.readProviders ? input.readProviders() : configuredSub2ApiProviders(environment),
      fetchPiAccountBalance({ ...input, environment, fetch: fetchImpl, signal }),
    ]);
    const wallets = await Promise.all(
      providers
        .filter((provider) => provider.apiKey.trim() && usageEndpoint(provider.baseUrl))
        .map((provider) => fetchSub2ApiBalance(provider, fetchImpl, signal).catch(() => null)),
    );
    return [...wallets, deepseek]
      .filter((account): account is HarnessAccountSnapshot => account !== null)
      .slice(0, MAX_PI_ACCOUNTS);
  } catch {
    return [];
  }
}

async function fetchPiAccountBalance(input: {
  environment: NodeJS.ProcessEnv;
  signal: AbortSignal;
  fetch: typeof fetch;
  readApiKey?: () => Promise<string | undefined>;
}): Promise<HarnessAccountSnapshot | null> {
  try {
    const key = await (input.readApiKey ? input.readApiKey() : deepSeekApiKey(input.environment));
    if (!key) return null;
    const response = await input.fetch(DEEPSEEK_BALANCE_ENDPOINT, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: input.signal,
    });
    if (!response.ok) return null;
    return projectDeepSeekBalance(await response.json());
  } catch {
    return null;
  }
}
