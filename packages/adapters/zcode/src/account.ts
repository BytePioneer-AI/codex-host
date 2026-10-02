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

// Start Plan entitlement, as ZCode Desktop decides it: the account's balance names the active plans
// and, per balance, the Models the plan allows. An account without such a plan must not be offered
// Start Plan Models: the CLI falls back to the first selectable Model when a Session has none, so
// an unentitled Start Plan Model would be used and rejected by the server.

/** ZCode's own endpoint override; Desktop gives `ZCODE_BASE_URL` the highest precedence. */
export function resolveEndpointOrigin(environment: NodeJS.ProcessEnv): string {
  return environment.ZCODE_BASE_URL?.trim() || "https://zcode.z.ai";
}

/** The device id Desktop sends as `X-Device-Mid`; the balance endpoint answers 400 without it. */
async function readDeviceMid(installation: ZcodeInstallation): Promise<string> {
  try {
    const file = path.join(installation.dataRoot, "telemetry-state.json");
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return typeof parsed?.deviceMid === "string" ? parsed.deviceMid.trim() : "";
  } catch {
    return "";
  }
}

const balanceResponseSchema = z.object({
  success: z.boolean().nullish(),
  code: z.number().nullish(),
  data: z
    .object({
      server_time: z.number().nullish(),
      plans: z
        .array(
          z.object({
            plan_id: z.string().nullish(),
            user_plan_id: z.string().nullish(),
            name: z.string().nullish(),
            status: z.string().nullish(),
            ends_at: z.union([z.number(), z.string()]).nullish(),
          }),
        )
        .nullish(),
      balances: z
        .array(
          z.object({
            user_plan_id: z.string().nullish(),
            plan_id: z.string().nullish(),
            capabilities: z.array(z.string()).nullish(),
            show_name: z.string().nullish(),
          }),
        )
        .nullish(),
    })
    .nullish(),
});
type BalanceData = z.infer<typeof balanceResponseSchema>["data"];

/**
 * The Models of the account's active, unexpired Start Plans, named as the installed App's
 * `builtinModelIds` spell them. Empty means the account is not entitled.
 */
function resolveStartPlanModels(data?: BalanceData, builtinModelIds?: string[]): string[] {
  if (!data?.plans || !data.balances) return [];
  const nowSec = data.server_time ?? Date.now() / 1000;
  const validPlans = data.plans.filter((plan) => {
    if (plan.status?.trim().toLowerCase() !== "active") return false;
    const id = plan.plan_id?.trim().toLowerCase();
    const name = plan.name?.trim().toLowerCase();
    const isStart =
      (!id && !name) ||
      id?.includes("start-plan") ||
      id?.includes("start plan") ||
      name?.includes("start-plan") ||
      name?.includes("start plan");
    if (!isStart) return false;
    const ends = Number(plan.ends_at);
    return !(Number.isFinite(ends) && ends > 0 && ends <= nowSec);
  });
  if (!validPlans.length) return [];

  const seen = new Set<string>();
  const models: string[] = [];
  for (const balance of data.balances) {
    const belongs = validPlans.some((plan) => {
      if (balance.user_plan_id && plan.user_plan_id)
        return plan.user_plan_id === balance.user_plan_id;
      if (balance.plan_id) return plan.plan_id === balance.plan_id;
      return !balance.user_plan_id;
    });
    if (!belongs) continue;
    const caps = (balance.capabilities ?? [])
      .map((c) => c.trim())
      .filter((c) => c.toLowerCase().startsWith("model:"))
      .map((c) => c.slice(6).trim())
      .filter(Boolean);
    const candidates = caps.length > 0 ? caps : [balance.show_name?.trim() ?? ""];
    for (const raw of candidates) {
      if (!raw) continue;
      const normalized =
        builtinModelIds?.find((id) => id.toLowerCase() === raw.toLowerCase()) ?? raw;
      const key = normalized.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        models.push(normalized);
      }
    }
  }
  return models;
}

async function queryStartPlanBalance(
  origin: string,
  appVersion: string,
  jwt: string,
  deviceMid: string,
): Promise<BalanceData | undefined> {
  try {
    const url = new URL(`${origin}/api/v1/zcode-plan/billing/balance`);
    url.searchParams.set("app_version", appVersion);
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "X-Device-Mid": deviceMid,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return undefined;
    const parsed = balanceResponseSchema.safeParse(await response.json());
    if (!parsed.success) return undefined;
    const payload = parsed.data;
    if (
      payload.success === false ||
      (payload.code != null && payload.code !== 0 && payload.code !== 200)
    ) {
      return undefined;
    }
    return payload.data;
  } catch {
    return undefined;
  }
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
  let balanceData: BalanceData | undefined;
  if (family) {
    const jwt = await readCredential(installation, environment, "zcodejwttoken");
    const deviceMid = await readDeviceMid(installation);
    if (jwt && deviceMid) {
      const origin = resolveEndpointOrigin(environment);
      balanceData = await queryStartPlanBalance(origin, installation.version, jwt, deviceMid);
    }
  }
  let startPlan = false;
  const providers: Record<string, unknown> = {};
  const states: Record<string, unknown> = {};
  for (const rule of builtin.config.providerConfigRules.providerRules) {
    const access = rule.config.access;
    if (!family || access?.mode !== "start-plan" || access.accountType !== family) continue;
    const allowedModels = resolveStartPlanModels(balanceData, rule.config.builtinModelIds);
    if (allowedModels.length > 0) {
      startPlan = true;
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
        unavailableReason: "not-entitled",
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
    startPlan,
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
