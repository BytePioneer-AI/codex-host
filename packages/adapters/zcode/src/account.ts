import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ZcodeError } from "./errors.js";
import type { ZcodeInstallation } from "./installation.js";
import type { ZcodeVerifier } from "./verification/index.js";
import { readCredential } from "./credentials.js";
import { PersonalCodingPlanAccount } from "./personal-coding-plan.js";

// Account configuration and request auth are read-only projections of ZCode Desktop state.
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

/** `provider/updateAccountConfig`: Start and Personal Coding Plan overlays; no credentials. */
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
  codingPlan: PersonalCodingPlanAccount;
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
    try {
      const jwt = await readCredential(installation, environment, "zcodejwttoken");
      const deviceMid = await readDeviceMid(installation);
      if (jwt && deviceMid) {
        const origin = resolveEndpointOrigin(environment);
        balanceData = await queryStartPlanBalance(origin, installation.version, jwt, deviceMid);
      }
    } catch {
      // A damaged Start credential must not disable a valid Coding Plan or personal Provider.
    }
  }
  let startPlan = false;
  const codingPlan = new PersonalCodingPlanAccount(installation, environment);
  const providers: Record<string, unknown> = {};
  const states: Record<string, unknown> = {};
  for (const rule of builtin.config.providerConfigRules.providerRules) {
    const access = rule.config.access;
    if (!family || access?.accountType !== family) continue;
    if (access.mode === "individual-coding-plan" && (family === "zai" || family === "bigmodel")) {
      const state = await codingPlan.inspect(rule.providerId, family);
      providers[rule.providerId] = {
        access: { type: "zhipu-account", entitled: state.entitled },
      };
      states[rule.providerId] = state;
      continue;
    }
    if (access.mode !== "start-plan") continue;
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
    codingPlan,
  };
}

/** Answers `interaction/requestProviderRuntimeHeaders`; failures are reported, never thrown. */
export async function providerRuntimeHeaders(
  request: Record<string, unknown>,
  signal: AbortSignal,
  installation: ZcodeInstallation,
  environment: NodeJS.ProcessEnv,
  verifier: () => ZcodeVerifier,
  codingPlan: PersonalCodingPlanAccount,
) {
  const mode = z.object({ mode: z.string() }).safeParse(request.accountAccess).data?.mode;
  try {
    if (mode === "individual-coding-plan")
      return { headersApplied: true, requestAuth: await codingPlan.requestAuth(request, signal) };
    if (mode !== "start-plan")
      return {
        headersApplied: false,
        errorMessage:
          "codexhost supports ZCode Start Plan and Personal Coding Plan; Team Coding Plan is not supported",
      };
    const apiKey = await readCredential(installation, environment, "zcodejwttoken");
    if (!apiKey) return { headersApplied: false, errorMessage: SIGN_IN };
    const headers = await verifier().verify(signal);
    return { headersApplied: true, requestAuth: { apiKey, headers } };
  } catch (error) {
    return {
      headersApplied: false,
      errorMessage:
        error instanceof ZcodeError ? error.message : "ZCode account authentication failed",
    };
  }
}
