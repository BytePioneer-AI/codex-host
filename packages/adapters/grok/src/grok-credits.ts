import { readFile } from "node:fs/promises";
import type { HarnessAccountSnapshot, HarnessLocalizations } from "@codexhost/shared-contracts";
import os from "node:os";
import path from "node:path";

export const GROK_CREDITS_ENDPOINT = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
/** The native CLI reads the subscription name from here (`subscription_tier_display`). */
export const GROK_SETTINGS_ENDPOINT = "https://cli-chat-proxy.grok.com/v1/settings";
const REQUEST_TIMEOUT_MS = 15_000;
/** The plan is optional decoration, so it never delays the quota for long. */
const PLAN_TIMEOUT_MS = 2_000;

export interface GrokProductUsage {
  product: string;
  localizations?: HarnessLocalizations | undefined;
  usagePercent: number;
}

export interface GrokCreditsSnapshot {
  usedPercent: number;
  resetsAt?: string;
  periodType: "weekly" | "monthly" | "unknown";
  productUsage?: GrokProductUsage[];
  fetchedAt: string;
}

export interface FetchGrokCreditsInput {
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  now?: Date;
  readAuthFile?(filePath: string): Promise<string>;
  fetch?(url: string, init: RequestInit): Promise<Response>;
}

export interface FetchGrokAccountInput extends FetchGrokCreditsInput {
  /** Also read the subscription name for the account page; Composer polling skips it. */
  includePlan?: boolean;
  planTimeoutMs?: number;
}

/** The subscription name from native /v1/settings, or undefined when it is not usable. */
export function parseGrokPlan(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.subscription_tier_display !== "string") return undefined;
  const plan = value.subscription_tier_display.trim();
  return plan && plan.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(plan) ? plan : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finitePercent(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(100, Math.max(0, value));
}

function nonNegativeCentValue(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  // Grok's Cent wrapper can omit val for zero amounts.
  const amount = value.val === undefined ? 0 : value.val;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) return undefined;
  return amount;
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
    const labels: Readonly<Record<string, string>> = {
      GrokBuild: "Build",
      GrokChat: "Chat",
      GrokImagine: "Imagine",
      GrokVoice: "Voice",
    };
    const label = Object.hasOwn(labels, entry.product) ? labels[entry.product] : undefined;
    return usagePercent === undefined
      ? []
      : [
          {
            product: entry.product,
            ...(label ? { localizations: { en: { label }, "zh-CN": { label } } } : {}),
            usagePercent,
          },
        ];
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
  const periodType = periodTypeFrom(period?.type);
  const resetsAt =
    (typeof period?.end === "string" && period.end.length > 0 ? period.end : undefined) ??
    (typeof config.billingPeriodEnd === "string" && config.billingPeriodEnd.length > 0
      ? config.billingPeriodEnd
      : undefined);
  let usedPercent = finitePercent(config.creditUsagePercent);
  if (config.creditUsagePercent === undefined) {
    const monthlyLimit = nonNegativeCentValue(config.monthlyLimit);
    const used = nonNegativeCentValue(config.used);
    if (
      (config.monthlyLimit !== undefined && monthlyLimit === undefined) ||
      (config.used !== undefined && used === undefined)
    )
      return null;
    // Follow Grok's included-credit calculation, never the separate on-demand spending cap.
    if (monthlyLimit !== undefined && monthlyLimit > 0) {
      usedPercent = Math.min(100, ((used ?? 0) / monthlyLimit) * 100);
    } else if (
      periodType !== "unknown" &&
      resetsAt !== undefined &&
      Number.isFinite(Date.parse(resetsAt))
    ) {
      // Grok defaults omitted usage to zero. Require a recognizable period, not just any config.
      usedPercent = 0;
    }
  }
  if (usedPercent === undefined) return null;
  const productUsage = productUsageFrom(config.productUsage);
  return {
    usedPercent,
    periodType,
    fetchedAt,
    ...(resetsAt ? { resetsAt } : {}),
    ...(productUsage ? { productUsage } : {}),
  };
}

function selectAccessToken(
  auth: unknown,
  now: Date,
): { key: string; email?: string; label?: string } | null {
  if (!isRecord(auth)) return null;
  const entries = Object.entries(auth)
    .filter(
      ([issuer, value]) =>
        (issuer === "https://auth.x.ai" || issuer.startsWith("https://auth.x.ai::")) &&
        isRecord(value) &&
        typeof value.key === "string" &&
        value.key.length > 0,
    )
    .sort(
      ([left], [right]) =>
        Number(right.startsWith("https://auth.x.ai")) -
        Number(left.startsWith("https://auth.x.ai")),
    );
  for (const [, value] of entries) {
    if (!isRecord(value) || typeof value.key !== "string") continue;
    if (typeof value.expires_at === "string") {
      const expiresAt = Date.parse(value.expires_at);
      if (Number.isFinite(expiresAt) && expiresAt <= now.getTime()) continue;
    }
    return {
      key: value.key,
      ...(typeof value.email === "string" && value.email.trim()
        ? { email: value.email.trim() }
        : {}),
      ...(typeof value.user_id === "string" && value.user_id.trim()
        ? { label: value.user_id.trim() }
        : {}),
    };
  }
  return null;
}

export async function fetchGrokAccount(
  input: FetchGrokAccountInput = {},
): Promise<HarnessAccountSnapshot | null> {
  try {
    const environment = input.environment ?? process.env;
    // Do not attribute a saved OAuth account to an explicitly API-configured environment.
    if (
      [environment.XAI_API_KEY, environment.GROK_API_KEY, environment.GROK_TOKEN].some((value) =>
        value?.trim(),
      )
    )
      return null;
    const now = input.now ?? new Date();
    const authPath = path.join(grokHome(environment), "auth.json");
    const raw = input.readAuthFile
      ? await input.readAuthFile(authPath)
      : await readFile(authPath, "utf8");
    const token = selectAccessToken(JSON.parse(raw) as unknown, now);
    if (!token) return null;
    const fetchImpl = input.fetch ?? fetch;
    const request = (url: string, timeoutMs: number): Promise<Response> =>
      fetchImpl(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token.key}`,
          "x-xai-token-auth": "xai-grok-cli",
          Accept: "application/json",
        },
        signal: input.signal
          ? AbortSignal.any([input.signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
      });
    const credits = request(GROK_CREDITS_ENDPOINT, REQUEST_TIMEOUT_MS);
    // Read in parallel with the quota; any failure only omits the plan.
    const plan =
      input.includePlan === false
        ? Promise.resolve(undefined)
        : request(GROK_SETTINGS_ENDPOINT, input.planTimeoutMs ?? PLAN_TIMEOUT_MS)
            .then(async (response) =>
              response.ok ? parseGrokPlan(await response.json()) : undefined,
            )
            .catch(() => undefined);
    const response = await credits;
    if (!response.ok) return null;
    const snapshot = parseGrokCreditsResponse(await response.json(), now.toISOString());
    if (!snapshot) return null;
    const planName = await plan;
    return {
      credits: {
        usedPercent: snapshot.usedPercent,
        periodType: snapshot.periodType,
        ...(snapshot.resetsAt ? { resetsAt: snapshot.resetsAt } : {}),
        ...(snapshot.productUsage ? { productUsage: [...snapshot.productUsage] } : {}),
      },
      ...(token.email ? { email: token.email } : {}),
      ...(token.label ? { label: token.label } : {}),
      ...(planName ? { plan: planName } : {}),
    };
  } catch {
    return null;
  }
}

export async function fetchGrokCredits(
  input: FetchGrokCreditsInput = {},
): Promise<GrokCreditsSnapshot | null> {
  const account = await fetchGrokAccount({ ...input, includePlan: false });
  if (!account?.credits) return null;
  const { credits } = account;
  return {
    usedPercent: credits.usedPercent,
    periodType:
      credits.periodType === "weekly" || credits.periodType === "monthly"
        ? credits.periodType
        : "unknown",
    fetchedAt: (input.now ?? new Date()).toISOString(),
    ...(credits.resetsAt ? { resetsAt: credits.resetsAt } : {}),
    ...(credits.productUsage ? { productUsage: credits.productUsage } : {}),
  };
}
