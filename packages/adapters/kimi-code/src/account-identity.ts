import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  harnessAccountSnapshotSchema,
  type AccountCreditsSnapshot,
  type HarnessAccountSnapshot,
} from "@codexhost/shared-contracts";
import { z } from "zod";

export const KIMI_USAGES_ENDPOINT = "https://api.kimi.com/coding/v1/usages";
const KIMI_OAUTH_TOKEN_ENDPOINT = "https://auth.kimi.com/api/oauth/token";
const KIMI_CODE_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const REQUEST_TIMEOUT_MS = 8_000;
const REFRESH_SKEW_MS = 60_000;

const credentialSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_at: z.number().optional(),
  expires_in: z.number().optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});
const refreshResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive().optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});

type NativeCredentials = z.infer<typeof credentialSchema>;
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

function kimiHome(environment: NodeJS.ProcessEnv): string {
  return environment.KIMI_CODE_HOME ?? join(environment.HOME ?? homedir(), ".kimi-code");
}

function credentialPath(environment: NodeJS.ProcessEnv): string {
  return join(kimiHome(environment), "credentials", "kimi-code.json");
}

function oauthTokenUrl(environment: NodeJS.ProcessEnv): string {
  const host = environment.KIMI_CODE_OAUTH_HOST ?? environment.KIMI_OAUTH_HOST;
  return host ? `${host.replace(/\/$/u, "")}/api/oauth/token` : KIMI_OAUTH_TOKEN_ENDPOINT;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function quantity(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function isFiveHourWindow(window: unknown): boolean {
  if (!isRecord(window)) return false;
  const duration = quantity(window.duration);
  const unit = String(window.timeUnit ?? "").toLowerCase();
  return duration === 300 && unit.includes("minute");
}

function usageShare(detail: unknown): { usedPercent: number; resetsAt?: string } | undefined {
  if (!isRecord(detail)) return undefined;
  const limit = quantity(detail.limit);
  const remaining = quantity(detail.remaining);
  const used =
    quantity(detail.used) ??
    (limit !== undefined && remaining !== undefined ? Math.max(0, limit - remaining) : undefined);
  if (limit === undefined || limit <= 0 || used === undefined || used < 0) return undefined;
  const resetsAt =
    typeof detail.resetTime === "string" && detail.resetTime ? detail.resetTime : undefined;
  return { usedPercent: Math.min(100, (used / limit) * 100), ...(resetsAt ? { resetsAt } : {}) };
}

function membershipPlan(user: unknown): string | undefined {
  if (!isRecord(user) || !isRecord(user.membership) || typeof user.membership.level !== "string")
    return undefined;
  return user.membership.level.replace(/^LEVEL_/u, "").trim() || undefined;
}

function nickname(user: unknown): string | undefined {
  if (!isRecord(user) || typeof user.nickname !== "string") return undefined;
  return user.nickname.trim() || undefined;
}

function expiresAtMs(expiresAt: number | undefined): number | undefined {
  if (expiresAt === undefined || !Number.isFinite(expiresAt)) return undefined;
  return expiresAt < 1e12 ? expiresAt * 1000 : expiresAt;
}

function accessTokenFresh(credentials: NativeCredentials, now: number): boolean {
  const expires = expiresAtMs(credentials.expires_at);
  return expires === undefined || expires - REFRESH_SKEW_MS > now;
}

/** Project the public coding-plan usages payload. Never accepts a token. */
export function projectKimiUsages(payload: unknown): HarnessAccountSnapshot | null {
  if (!isRecord(payload)) return null;
  const weekly = usageShare(payload.usage);
  if (!weekly) return null;
  const productUsage = (Array.isArray(payload.limits) ? payload.limits : []).flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const share = usageShare(entry.detail);
    if (!share || !isFiveHourWindow(entry.window)) return [];
    return [
      {
        product: "Kimi Code · 5-hour window",
        usagePercent: share.usedPercent,
        ...(share.resetsAt ? { resetsAt: share.resetsAt } : {}),
      },
    ];
  });
  const credits: AccountCreditsSnapshot = {
    usedPercent: weekly.usedPercent,
    periodType: "weekly",
    ...(weekly.resetsAt ? { resetsAt: weekly.resetsAt } : {}),
    ...(productUsage.length ? { productUsage } : {}),
  };
  const plan = membershipPlan(payload.user);
  const label = nickname(payload.user);
  const parsed = harnessAccountSnapshotSchema.safeParse({
    label: label || "Kimi Code",
    ...(plan ? { plan } : {}),
    credits,
  });
  return parsed.success ? parsed.data : null;
}

async function readNativeCredentials(
  filePath: string,
  readAuthFile: (path: string) => Promise<string>,
): Promise<{ raw: Record<string, unknown>; credentials: NativeCredentials } | undefined> {
  try {
    const raw = JSON.parse(await readAuthFile(filePath)) as unknown;
    if (!isRecord(raw)) return undefined;
    const parsed = credentialSchema.safeParse(raw);
    return parsed.success ? { raw, credentials: parsed.data } : undefined;
  } catch {
    return undefined;
  }
}

async function defaultWriteAuthFile(filePath: string, contents: string): Promise<void> {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, filePath);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function refreshNativeCredentials(
  environment: NodeJS.ProcessEnv,
  stored: { raw: Record<string, unknown>; credentials: NativeCredentials },
  filePath: string,
  fetchImpl: FetchLike,
  writeAuthFile: (path: string, contents: string) => Promise<void>,
  signal: AbortSignal,
  now: number,
): Promise<string | undefined> {
  const refreshToken = stored.credentials.refresh_token;
  if (!refreshToken) return undefined;
  const response = await fetchImpl(oauthTokenUrl(environment), {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: KIMI_CODE_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    signal,
  });
  if (!response.ok) return undefined;
  const parsed = refreshResponseSchema.safeParse(await response.json());
  if (!parsed.success) return undefined;
  const expiresIn = parsed.data.expires_in ?? stored.credentials.expires_in ?? 900;
  const next = {
    ...stored.raw,
    access_token: parsed.data.access_token,
    refresh_token: parsed.data.refresh_token ?? refreshToken,
    expires_in: expiresIn,
    expires_at: now / 1000 + expiresIn,
    ...(parsed.data.scope ? { scope: parsed.data.scope } : {}),
    ...(parsed.data.token_type ? { token_type: parsed.data.token_type } : {}),
  };
  await writeAuthFile(filePath, `${JSON.stringify(next, undefined, 2)}\n`).catch(() => undefined);
  stored.raw = next;
  stored.credentials = {
    ...stored.credentials,
    access_token: parsed.data.access_token,
    refresh_token: parsed.data.refresh_token ?? refreshToken,
    expires_in: expiresIn,
    expires_at: now / 1000 + expiresIn,
  };
  return parsed.data.access_token;
}

export interface FetchKimiAccountInput {
  environment?: NodeJS.ProcessEnv;
  readAuthFile?(path: string): Promise<string>;
  writeAuthFile?(path: string, contents: string): Promise<void>;
  fetch?: FetchLike;
  signal?: AbortSignal;
  now?: number;
}

/** Read-only coding-plan quota. Refreshes the native file; does not start `kimi`. */
export async function fetchKimiAccount(
  input: FetchKimiAccountInput = {},
): Promise<HarnessAccountSnapshot | null> {
  try {
    const environment = input.environment ?? process.env;
    const fromEnv = environment.KIMI_CODE_API_KEY?.trim() || environment.KIMI_API_KEY?.trim();
    const readAuthFile = input.readAuthFile ?? ((filePath) => readFile(filePath, "utf8"));
    const writeAuthFile = input.writeAuthFile ?? defaultWriteAuthFile;
    const fetchImpl = input.fetch ?? fetch;
    const requestSignal = () =>
      input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
        : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const now = input.now ?? Date.now();
    const filePath = credentialPath(environment);
    const stored = fromEnv ? undefined : await readNativeCredentials(filePath, readAuthFile);
    let token = fromEnv ?? stored?.credentials.access_token;
    if (!token) return null;
    if (stored && !accessTokenFresh(stored.credentials, now)) {
      token =
        (await refreshNativeCredentials(
          environment,
          stored,
          filePath,
          fetchImpl,
          writeAuthFile,
          requestSignal(),
          now,
        )) ?? token;
    }
    const requestUsages = (accessToken: string) =>
      fetchImpl(KIMI_USAGES_ENDPOINT, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        signal: requestSignal(),
      });
    let response = await requestUsages(token);
    if (response.status === 401 && stored?.credentials.refresh_token) {
      const refreshed = await refreshNativeCredentials(
        environment,
        stored,
        filePath,
        fetchImpl,
        writeAuthFile,
        requestSignal(),
        now,
      );
      if (!refreshed) return null;
      token = refreshed;
      response = await requestUsages(token);
    }
    if (!response.ok) return null;
    return projectKimiUsages(await response.json());
  } catch {
    return null;
  }
}
