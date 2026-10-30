import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { readCredentials } from "./credentials.js";
import { ZcodeError } from "./errors.js";
import type { ZcodeInstallation } from "./installation.js";

const familySchema = z.enum(["zai", "bigmodel"]);
type Family = z.infer<typeof familySchema>;
const recordSchema = z.record(z.string(), z.unknown());
const CONNECT =
  "Connect Personal Coding Plan in ZCode Desktop, then re-detect ZCode and reopen the Thread";

interface AccountContext {
  identity: string;
  apiKey: string;
  current: boolean;
}
interface AccountState {
  availability: "available" | "unavailable" | "unknown";
  entitled: boolean;
  current: boolean;
  connectionKey?: string;
  unavailableReason?: "not-connected" | "credential-failed" | "not-entitled";
}
type Entitlement = "available" | "unavailable" | "unknown" | "credential-failed";

/** Same business origins and explicit environment overrides as ZCode Desktop, not ZCODE_BASE_URL. */
export function personalCodingPlanOrigin(family: Family, environment: NodeJS.ProcessEnv): string {
  const test = environment.ZCODE_ENV?.trim().toLowerCase() === "test";
  const prefix = family === "zai" ? "ZAI" : "BIGMODEL";
  const suffix = family === "zai" ? "BUSINESS_BASE_URL" : "API_BASE_URL";
  const origin =
    environment[`${prefix}_${suffix}`]?.trim() ||
    environment[`${prefix}_${test ? "TEST" : "PRODUCTION"}_${suffix}`]?.trim() ||
    (family === "zai"
      ? test
        ? "https://api.chatglm.site"
        : "https://api.z.ai"
      : test
        ? "https://dev.bigmodel.cn"
        : "https://bigmodel.cn");
  const url = new URL(origin);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Invalid ZCode business origin");
  return url.origin;
}

/** Desktop settings have a different home override from the credentials/data directory. */
async function readSelection(environment: NodeJS.ProcessEnv, family: Family) {
  const home =
    environment.ZCODE_DESKTOP_HOME_DIR?.trim() ||
    environment.HOME?.trim() ||
    environment.USERPROFILE?.trim() ||
    homedir();
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.join(home, ".zcode", "v2", "setting.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new ZcodeError("configurationRequired", CONNECT);
  }
  const settings = recordSchema.parse(raw);
  if (settings.providerFamilyDomain !== family) return false;
  if (Object.hasOwn(settings, "providerFamilyConnectionSelections")) {
    const selections = recordSchema.parse(settings.providerFamilyConnectionSelections);
    return z.object({ kind: z.literal("individual-coding-plan") }).safeParse(selections[family])
      .success;
  }
  // Read-only compatibility with Desktop's legacy personal selection. Never infer a Team scope.
  const modes = recordSchema.safeParse(settings.modelProviderFamilyModes).data;
  const keys = recordSchema.safeParse(settings.modelProviderFamilySelectedKeys).data;
  return (
    modes?.[family] !== "apiKey" && keys?.[family] === `coding-plan:builtin:${family}-coding-plan`
  );
}

const envelopeSchema = z.object({
  success: z.boolean().optional(),
  code: z.number().optional(),
  data: z.array(z.unknown()),
});
const subscriptionSchema = z.object({
  productId: z.string().optional(),
  productName: z.string().optional(),
  status: z.string(),
  inCurrentPeriod: z.boolean(),
});
function codingProduct(value: unknown) {
  const entry = recordSchema.safeParse(value).data;
  return [entry?.productId, entry?.productName].some(
    (field) => typeof field === "string" && field.toLowerCase().includes("coding"),
  );
}
async function queryEntitlement(
  family: Family,
  apiKey: string,
  environment: NodeJS.ProcessEnv,
): Promise<Entitlement> {
  try {
    const response = await fetch(
      `${personalCodingPlanOrigin(family, environment)}/api/biz/subscription/list`,
      {
        method: "GET",
        // The subscription endpoint accepts the model API Key, not the OAuth token or Start JWT.
        headers: { Authorization: apiKey.trim() },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (response.status === 401 || response.status === 403) return "credential-failed";
    if (!response.ok) return "unknown";
    const parsed = envelopeSchema.safeParse(await response.json());
    if (!parsed.success) return "unknown";
    const payload = parsed.data;
    if (
      payload.success === false ||
      (payload.code !== undefined && ![0, 200].includes(payload.code))
    )
      return "unknown";
    let malformed = false;
    for (const item of payload.data) {
      if (!codingProduct(item)) continue;
      const subscription = subscriptionSchema.safeParse(item);
      if (!subscription.success) malformed = true;
      else if (subscription.data.status === "VALID" && subscription.data.inCurrentPeriod)
        return "available";
    }
    return malformed ? "unknown" : "unavailable";
  } catch {
    return "unknown";
  }
}

/** Per-transport account scope. Keys stay in local reads and are never part of the CLI overlay. */
export class PersonalCodingPlanAccount {
  #authorized = new Map<string, { family: Family; identity: string }>();
  constructor(
    private readonly installation: ZcodeInstallation,
    private readonly environment: NodeJS.ProcessEnv,
  ) {}

  async #context(providerId: string, family: Family): Promise<AccountContext | undefined> {
    const [credential, current] = await Promise.all([
      readCredentials(this.installation, this.environment),
      readSelection(this.environment, family),
    ]);
    if (credential("oauth:active_provider") !== family) return undefined;
    const raw = credential(`oauth:${family}:user_info`);
    if (!raw) return undefined;
    const profile = recordSchema.parse(JSON.parse(raw));
    // Desktop stores either a normalized OAuth profile or Z.AI's raw data.user object.
    const normalized = z
      .object({ id: z.string(), username: z.string(), displayName: z.string() })
      .safeParse(profile).data;
    const identity = normalized
      ? normalized.id.trim()
      : family === "zai" && typeof profile.user_id === "string"
        ? profile.user_id.trim()
        : "";
    if (!identity || identity === "unknown") return undefined;
    const key = `account-provider:coding-plan:${providerId}:account:${encodeURIComponent(identity)}:api-key`;
    return { identity, current, apiKey: credential(key).trim() };
  }

  async inspect(providerId: string, accountType: string): Promise<AccountState> {
    const family = familySchema.parse(accountType);
    this.#authorized.delete(providerId);
    let current = false;
    try {
      const context = await this.#context(providerId, family);
      if (!context)
        return {
          availability: "unavailable",
          entitled: false,
          current,
          unavailableReason: "not-connected",
        };
      current = context.current;
      const connectionKey = createHash("sha256")
        .update(JSON.stringify([family, context.identity, "individual-coding-plan"]))
        .digest("hex");
      const base = { current, connectionKey };
      if (!context.apiKey)
        return {
          ...base,
          availability: "unavailable",
          entitled: false,
          unavailableReason: "credential-failed",
        };
      const entitlement = await queryEntitlement(family, context.apiKey, this.environment);
      // A query may cross a Desktop account/selection/key change. Never publish mixed identities.
      const after = await this.#context(providerId, family);
      if (
        !after ||
        after.identity !== context.identity ||
        after.current !== current ||
        after.apiKey !== context.apiKey
      )
        return { availability: "unknown", entitled: false, current: false };
      if (entitlement === "available") {
        if (current) this.#authorized.set(providerId, { family, identity: context.identity });
        return { ...base, availability: "available", entitled: true };
      }
      return {
        ...base,
        availability: entitlement === "unknown" ? "unknown" : "unavailable",
        entitled: false,
        ...(entitlement === "unknown"
          ? {}
          : {
              unavailableReason:
                entitlement === "unavailable"
                  ? ("not-entitled" as const)
                  : ("credential-failed" as const),
            }),
      };
    } catch {
      // An unreadable personal key/profile/settings must not break Start or personal Providers.
      return { availability: "unknown", entitled: false, current };
    }
  }

  async requestAuth(request: Record<string, unknown>, signal: AbortSignal) {
    const parsed = z
      .object({
        providerId: z.string(),
        modelSelection: z.object({ providerId: z.string() }),
        accountAccess: z.object({
          type: z.literal("zhipu-account"),
          mode: z.literal("individual-coding-plan"),
          accountType: familySchema,
        }),
      })
      .safeParse(request);
    if (!parsed.success) throw new ZcodeError("authenticationRequired", CONNECT);
    const { providerId, modelSelection, accountAccess } = parsed.data;
    const authorized = this.#authorized.get(providerId);
    if (
      !authorized ||
      authorized.family !== accountAccess.accountType ||
      modelSelection.providerId !== providerId
    )
      throw new ZcodeError("authenticationRequired", CONNECT);
    signal.throwIfAborted();
    const context = await this.#context(providerId, authorized.family);
    signal.throwIfAborted();
    if (!context?.current || context.identity !== authorized.identity || !context.apiKey)
      throw new ZcodeError("authenticationRequired", CONNECT);
    return { apiKey: context.apiKey };
  }
}
