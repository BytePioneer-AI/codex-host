import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const GROK_CREDITS_ENDPOINT = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const REQUEST_TIMEOUT_MS = 15_000;

export interface GrokProductUsage {
  product: string;
  usagePercent: number;
}

export interface GrokCreditsSnapshot {
  usedPercent: number;
  resetsAt?: string;
  periodType: "weekly" | "monthly" | "unknown";
  productUsage?: ReadonlyArray<GrokProductUsage>;
  fetchedAt: string;
}

export interface FetchGrokCreditsInput {
  environment?: NodeJS.ProcessEnv;
  now?: Date;
  readAuthFile?(filePath: string): Promise<string>;
  fetch?(url: string, init: RequestInit): Promise<Response>;
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

function grokHome(environment: NodeJS.ProcessEnv): string {
  return (
    environment.GROK_HOME ??
    path.join(environment.HOME ?? environment.USERPROFILE ?? os.homedir(), ".grok")
  );
}

function periodTypeFrom(value: unknown): GrokCreditsSnapshot["periodType"] {
  if (typeof value !== "string") return "unknown";
  const normalized = value.toUpperCase();
  if (normalized.includes("WEEKLY")) return "weekly";
  if (normalized.includes("MONTHLY")) return "monthly";
  return "unknown";
}

function productUsageFrom(value: unknown): GrokProductUsage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const products = value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.product !== "string") return [];
    const usagePercent = finitePercent(entry.usagePercent);
    return usagePercent === undefined ? [] : [{ product: entry.product, usagePercent }];
  });
  return products.length > 0 ? products : undefined;
}

export function parseGrokCreditsResponse(
  value: unknown,
  fetchedAt = new Date().toISOString(),
): GrokCreditsSnapshot | null {
  if (!isRecord(value) || !isRecord(value.config)) return null;
  const config = value.config;
  const period = isRecord(config.currentPeriod) ? config.currentPeriod : undefined;
  const resetsAt =
    (typeof period?.end === "string" && period.end.length > 0 ? period.end : undefined) ??
    (typeof config.billingPeriodEnd === "string" && config.billingPeriodEnd.length > 0
      ? config.billingPeriodEnd
      : undefined);
  const onDemandCap = isRecord(config.onDemandCap)
    ? nonNegativeNumber(config.onDemandCap.val)
    : undefined;
  const onDemandUsed = isRecord(config.onDemandUsed)
    ? nonNegativeNumber(config.onDemandUsed.val)
    : undefined;
  const usedPercent =
    finitePercent(config.creditUsagePercent) ??
    (onDemandCap !== undefined && onDemandCap > 0 && onDemandUsed !== undefined
      ? Math.min(100, Math.max(0, (onDemandUsed / onDemandCap) * 100))
      : resetsAt
        ? 0
        : undefined);
  if (usedPercent === undefined) return null;
  const productUsage = productUsageFrom(config.productUsage);
  return {
    usedPercent,
    periodType: periodTypeFrom(period?.type),
    fetchedAt,
    ...(resetsAt ? { resetsAt } : {}),
    ...(productUsage ? { productUsage } : {}),
  };
}

function selectAccessToken(auth: unknown, now: Date): string | null {
  if (!isRecord(auth)) return null;
  const entries = Object.entries(auth)
    .filter(([, value]) => isRecord(value) && typeof value.key === "string" && value.key.length > 0)
    .sort(([left], [right]) => Number(right.startsWith("https://auth.x.ai")) - Number(left.startsWith("https://auth.x.ai")));
  for (const [, value] of entries) {
    if (!isRecord(value) || typeof value.key !== "string") continue;
    if (typeof value.expires_at === "string") {
      const expiresAt = Date.parse(value.expires_at);
      if (Number.isFinite(expiresAt) && expiresAt <= now.getTime()) continue;
    }
    return value.key;
  }
  return null;
}

export async function fetchGrokCredits(
  input: FetchGrokCreditsInput = {},
): Promise<GrokCreditsSnapshot | null> {
  try {
    const environment = input.environment ?? process.env;
    const now = input.now ?? new Date();
    const authPath = path.join(grokHome(environment), "auth.json");
    const raw = input.readAuthFile
      ? await input.readAuthFile(authPath)
      : await readFile(authPath, "utf8");
    const token = selectAccessToken(JSON.parse(raw) as unknown, now);
    if (!token) return null;
    const fetchImpl = input.fetch ?? fetch;
    const response = await fetchImpl(GROK_CREDITS_ENDPOINT, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "x-xai-token-auth": "xai-grok-cli",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return parseGrokCreditsResponse(await response.json(), now.toISOString());
  } catch {
    return null;
  }
}
