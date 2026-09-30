import { createDecipheriv, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir, platform, userInfo } from "node:os";
import path from "node:path";
import { z } from "zod";
import { ZcodeError } from "./errors.js";
import type { ZcodeInstallation } from "./installation.js";
import type { ZcodeVerifier } from "./verification/index.js";

// The account layer reads ZCode Desktop's sign-in state without writing it. The Start Plan JWT
// is decrypted only while answering one header request and never leaves this module otherwise.
const SIGN_IN = "Sign in to ZCode Desktop with a Start Plan account, then try again";
const builtinSchema = z.object({
  revision: z.union([z.number(), z.string()]),
  config: z.object({
    providerConfigRules: z.object({
      providerRules: z.array(
        z.object({
          providerId: z.string().min(1),
          config: z.object({
            builtinModelIds: z.array(z.string()).optional(),
            access: z.object({ mode: z.string(), accountType: z.string() }).partial().optional(),
          }),
        }),
      ),
    }),
  }),
});

/** ZCode's credential cipher: `enc:v1:<iv>.<tag>.<ciphertext>`, AES-256-GCM, sha256 key. */
function decrypt(value: string, environment: NodeJS.ProcessEnv) {
  if (!value.startsWith("enc:v1:")) return value;
  let username = "unknown";
  try {
    username = userInfo().username;
  } catch {
    // ZCode derives the same fallback when the platform has no user record.
  }
  const secret =
    environment.ZCODE_CREDENTIAL_SECRET ||
    `zcode-credential-fallback:${platform()}:${environment.HOME || homedir()}:${username}`;
  const [iv, tag, data, extra] = value.slice(7).split(".");
  try {
    if (!iv || !tag || !data || extra !== undefined) throw new Error();
    const decipher = createDecipheriv(
      "aes-256-gcm",
      createHash("sha256").update(secret).digest(),
      Buffer.from(iv, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()])
      .toString("utf8")
      .trim();
  } catch {
    throw new ZcodeError(
      "authenticationRequired",
      "Cannot decrypt ZCode credentials; ZCODE_CREDENTIAL_SECRET must match ZCode Desktop",
    );
  }
}

async function readCredential(
  installation: ZcodeInstallation,
  environment: NodeJS.ProcessEnv,
  key: "oauth:active_provider" | "zcodejwttoken",
): Promise<string> {
  let store: unknown;
  try {
    store = JSON.parse(
      await readFile(path.join(installation.dataRoot, "credentials.json"), "utf8"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw new ZcodeError("authenticationRequired", "Cannot read ZCode credentials");
  }
  const value = z.record(z.string(), z.string()).safeParse(store).data?.[key];
  return value ? decrypt(value, environment) : "";
}

/**
 * Resolves the ZCode endpoint origin following ZCode's runtime environment contract:
 * ZCODE_BASE_URL ?? ZCODE_ENDPOINT_ORIGIN ?? (ZCODE_ENV === "test" ? ZCODE_TEST_BASE_URL : ZCODE_PRODUCTION_BASE_URL)
 * defaulting to https://zcode.z.ai (or https://zcode.chatglm.site when ZCODE_ENV=test).
 */
export function resolveEndpointOrigin(environment: NodeJS.ProcessEnv): string {
  const isTest = environment.ZCODE_ENV?.trim().toLowerCase() === "test";
  const explicit =
    environment.ZCODE_BASE_URL?.trim() ||
    environment.ZCODE_ENDPOINT_ORIGIN?.trim() ||
    (isTest
      ? environment.ZCODE_TEST_BASE_URL?.trim()
      : environment.ZCODE_PRODUCTION_BASE_URL?.trim());
  if (explicit) {
    try {
      const url = new URL(explicit);
      if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
    } catch {
      // Ignore invalid URL
    }
  }
  return isTest ? "https://zcode.chatglm.site" : "https://zcode.z.ai";
}

async function readDeviceMid(installation: ZcodeInstallation): Promise<string> {
  try {
    const file = path.join(installation.dataRoot, "telemetry-state.json");
    const content = await readFile(file, "utf8");
    const parsed = JSON.parse(content);
    return typeof parsed?.deviceMid === "string" ? parsed.deviceMid.trim() : "";
  } catch {
    return "";
  }
}

function normalizeModelId(capabilityName: string, builtinModelIds?: string[]): string {
  if (builtinModelIds) {
    const match = builtinModelIds.find((id) => id.toLowerCase() === capabilityName.toLowerCase());
    if (match) return match;
  }
  return capabilityName;
}

function resolveStartPlanModels(
  balances?: Array<{ capabilities?: string[]; show_name?: string }>,
  builtinModelIds?: string[],
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const balance of balances ?? []) {
    const modelCapabilities = (balance.capabilities ?? [])
      .map((c) => {
        const trimmed = c.trim();
        return trimmed.toLowerCase().startsWith("model:") ? trimmed.slice(6).trim() : "";
      })
      .filter(Boolean);
    const candidates = modelCapabilities.length > 0 ? modelCapabilities : [balance.show_name ?? ""];
    for (const raw of candidates) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const normalized = normalizeModelId(trimmed, builtinModelIds);
      const lower = normalized.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        result.push(normalized);
      }
    }
  }
  return result;
}

function isStartPlanIdentity(value?: string): boolean {
  return Boolean(value && (value.includes("start-plan") || value.includes("start plan")));
}

function hasActiveStartPlan(
  plans?: Array<{ plan_id?: string; name?: string; status?: string }>,
): boolean {
  return Boolean(
    plans?.some((plan) => {
      const status = plan.status?.trim().toLowerCase();
      const planId = plan.plan_id?.trim().toLowerCase();
      const name = plan.name?.trim().toLowerCase();
      const isStartPlan =
        !planId && !name ? true : isStartPlanIdentity(planId) || isStartPlanIdentity(name);
      return status === "active" && isStartPlan;
    }),
  );
}

interface BalancePlan {
  plan_id?: string;
  user_plan_id?: string;
  name?: string;
  status?: string;
  starts_at?: string | number;
  ends_at?: string | number;
  entitlements?: Array<{ effective_at?: string | number }>;
}

interface BalanceItem {
  user_plan_id?: string;
  plan_id?: string;
  capabilities?: string[];
  show_name?: string;
}

interface BalanceResponsePayload {
  success?: boolean;
  code?: number;
  data?: {
    server_time?: number;
    plans?: BalancePlan[];
    balances?: BalanceItem[];
  };
}

/**
 * Normalizes Start Plan expiry following Desktop's `normalizeStartPlanExpiry` (`Epe` in `out/host/index.js`):
 * an active plan whose ends_at is finite, >0 and <= server_time (else now) becomes status 'expired',
 * and balances whose owning plans (matched by user_plan_id, else plan_id) are all expired are dropped.
 */
function normalizeStartPlanExpiry(payload: BalanceResponsePayload): BalanceResponsePayload {
  if (!payload.data) return payload;
  const serverTime = payload.data.server_time;
  const currentSeconds =
    typeof serverTime === "number" && Number.isFinite(serverTime) && serverTime >= 0
      ? serverTime
      : Date.now() / 1000;
  const plans = (payload.data.plans ?? []).map((plan) => {
    const endsAt = Number(plan.ends_at);
    return plan.status?.trim().toLowerCase() === "active" &&
      Number.isFinite(endsAt) &&
      endsAt > 0 &&
      endsAt <= currentSeconds
      ? { ...plan, status: "expired" }
      : plan;
  });
  const balances = payload.data.balances?.filter((balance) => {
    const matched = plans.filter((plan) =>
      balance.user_plan_id && plan.user_plan_id
        ? plan.user_plan_id === balance.user_plan_id
        : plan.plan_id === balance.plan_id,
    );
    return (
      !matched.length || matched.some((plan) => plan.status?.trim().toLowerCase() !== "expired")
    );
  });
  return {
    ...payload,
    data: {
      ...payload.data,
      plans,
      ...(balances ? { balances } : {}),
    },
  };
}

function isPlanPending(
  data: {
    server_time?: number;
    plans?: BalancePlan[];
  },
  hasModels: boolean,
): boolean {
  if (hasModels) return false;
  const serverTime =
    typeof data.server_time === "number" &&
    Number.isFinite(data.server_time) &&
    data.server_time >= 0
      ? data.server_time
      : Date.now() / 1000;
  const effectiveTimes = (data.plans ?? [])
    .filter((p) => p.status?.trim().toLowerCase() === "active")
    .flatMap((p) =>
      p.entitlements?.length ? p.entitlements.map((e) => e.effective_at) : [p.starts_at],
    )
    .map((t) => (t === null || t === undefined || t === "" ? undefined : Number(t)));
  return (
    effectiveTimes.length > 0 &&
    effectiveTimes.every((t) => t !== undefined && Number.isFinite(t) && t > serverTime)
  );
}

const BALANCE_TIMEOUT_MS = 15_000;

type StartPlanBalanceResult =
  { entitled: true; balances: BalanceItem[] } | { entitled: false; unavailableReason: string };

async function queryStartPlanBalance(
  origin: string,
  appVersion: string,
  jwt: string,
  deviceMid: string,
): Promise<StartPlanBalanceResult> {
  const url = new URL(`${origin}/api/v1/zcode-plan/billing/balance`);
  url.searchParams.set("app_version", appVersion);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "X-Device-Mid": deviceMid,
      },
      signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
      credentials: "omit",
    });
  } catch {
    return { entitled: false, unavailableReason: "not-entitled" };
  }
  if (!response.ok) {
    return {
      entitled: false,
      unavailableReason:
        response.status === 401 || response.status === 403 ? "credential-failed" : "not-entitled",
    };
  }
  let payload: BalanceResponsePayload;
  try {
    payload = (await response.json()) as BalanceResponsePayload;
  } catch {
    return { entitled: false, unavailableReason: "not-entitled" };
  }
  const isSuccess =
    payload?.success !== false &&
    (payload?.code === undefined || payload?.code === 0 || payload?.code === 200);
  if (!isSuccess) {
    return { entitled: false, unavailableReason: "not-entitled" };
  }
  payload = normalizeStartPlanExpiry(payload);
  const plans = payload.data?.plans;
  if (!hasActiveStartPlan(plans)) {
    return { entitled: false, unavailableReason: "not-entitled" };
  }
  const balances = payload.data?.balances ?? [];
  const rawModels = resolveStartPlanModels(balances);
  if (isPlanPending(payload.data ?? {}, rawModels.length > 0)) {
    return { entitled: false, unavailableReason: "not-entitled" };
  }
  return { entitled: true, balances };
}

/** `provider/updateAccountConfig` params: the Start Plan overlay for the signed-in account family. */
export async function accountConfig(
  installation: ZcodeInstallation,
  environment: NodeJS.ProcessEnv,
): Promise<{
  params: {
    revision: string;
    basedOnZCodeBuiltinRevision: string;
    providers: Record<string, unknown>;
    states: Record<string, unknown>;
  };
  startPlan: boolean;
}> {
  const file = installation.builtinProviderConfig;
  const builtin = builtinSchema.parse(JSON.parse(await readFile(file, "utf8")));
  // The CLI keeps its previous registry unless this matches its own Built-in layer revision.
  const basedOnZCodeBuiltinRevision = `zcode-builtin:${builtin.revision}:${createHash("sha256")
    .update(path.resolve(file))
    .digest("hex")}`;
  const family = await readCredential(installation, environment, "oauth:active_provider");
  let balanceResult: StartPlanBalanceResult = {
    entitled: false,
    unavailableReason: "not-entitled",
  };
  if (family) {
    const jwt = await readCredential(installation, environment, "zcodejwttoken");
    const deviceMid = await readDeviceMid(installation);
    if (jwt && deviceMid) {
      const origin = resolveEndpointOrigin(environment);
      balanceResult = await queryStartPlanBalance(origin, installation.version, jwt, deviceMid);
    }
  }
  const providers: Record<string, unknown> = {};
  const states: Record<string, unknown> = {};
  for (const rule of builtin.config.providerConfigRules.providerRules) {
    const access = rule.config.access;
    if (!family || access?.mode !== "start-plan" || access.accountType !== family) continue;
    if (balanceResult.entitled) {
      const allowedModels = resolveStartPlanModels(
        balanceResult.balances,
        rule.config.builtinModelIds,
      );
      providers[rule.providerId] = {
        builtinModelIds: allowedModels,
        access: { type: "zhipu-account", entitled: true },
      };
      states[rule.providerId] = { availability: "available", entitled: true, current: true };
    } else {
      providers[rule.providerId] = {
        access: { type: "zhipu-account", entitled: false },
      };
      states[rule.providerId] = {
        availability: "unavailable",
        entitled: false,
        unavailableReason: balanceResult.unavailableReason,
        current: true,
      };
    }
  }
  const overlayDigest = createHash("sha256")
    .update(JSON.stringify([providers, states]))
    .digest("hex")
    .slice(0, 16);
  return {
    params: {
      revision: `codexhost:${family || "signed-out"}:${builtin.revision}:${overlayDigest}`,
      basedOnZCodeBuiltinRevision,
      providers,
      states,
    },
    startPlan: balanceResult.entitled,
  };
}

/** Answers `interaction/requestProviderRuntimeHeaders`; failures are reported, never thrown. */
export async function providerRuntimeHeaders(
  accountAccess: unknown,
  signal: AbortSignal,
  installation: ZcodeInstallation,
  environment: NodeJS.ProcessEnv,
  verifier: () => ZcodeVerifier,
) {
  if (z.object({ mode: z.literal("start-plan") }).safeParse(accountAccess).success !== true)
    return {
      headersApplied: false,
      errorMessage: "codexhost supports only the ZCode Start Plan account",
    };
  try {
    const apiKey = await readCredential(installation, environment, "zcodejwttoken");
    if (!apiKey) return { headersApplied: false, errorMessage: SIGN_IN };
    const headers = await verifier().verify(signal);
    return { headersApplied: true, requestAuth: { apiKey, headers } };
  } catch (error) {
    return {
      headersApplied: false,
      errorMessage:
        error instanceof ZcodeError ? error.message : "ZCode Start Plan verification failed",
    };
  }
}
