import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { plaintextCredential, readCredentials, ZcodeCredentialError } from "./credentials.js";
import type { ReadSystemKeyOptions } from "./credential-keyring.js";
import { readLoginChannel, readOAuthUserId, type CredentialReader } from "./oauth-account.js";
import { ZcodeError } from "./errors.js";
import type { ZcodeInstallation } from "./installation.js";
import { ProjectToken, readProjectCredential, type ProjectCredential } from "./project-token.js";

const familySchema = z.enum(["zai", "bigmodel"]);
type Family = z.infer<typeof familySchema>;
const recordSchema = z.record(z.string(), z.unknown());
const CONNECT =
  "Connect Personal Coding Plan in ZCode Desktop, then re-detect ZCode and reopen the Thread";

type AccountContext = {
  identity: string;
  account: string;
  current: boolean;
} & ({ project: ProjectCredential; apiKey?: never } | { project?: never; apiKey: string });

const linkedBigModelSchema = z.object({
  userId: z.string(),
  customerId: z.string().trim().min(1),
  accessToken: z.string().trim().min(1),
});
function parseBigModelLink(raw: string) {
  try {
    return linkedBigModelSchema.safeParse(JSON.parse(raw)).data;
  } catch {
    // An invalid link does not invalidate the primary ZCode login.
    return undefined;
  }
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
        // Desktop checks the model credential: a personal API Key or a project token.
        headers: {
          Authorization: apiKey
            .trim()
            .replace(/^Bearer\s+/i, "")
            .trim(),
        },
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
  #authorized = new Map<string, { family: Family; account: string }>();
  #projectToken = new ProjectToken();
  issue: string | undefined;
  constructor(
    private readonly installation: ZcodeInstallation,
    private readonly environment: NodeJS.ProcessEnv,
    private readonly readSystemKeyOptions?: ReadSystemKeyOptions,
  ) {}

  async #context(
    providerId: string,
    family: Family,
    existingCredential?: CredentialReader,
  ): Promise<AccountContext | undefined> {
    const [credential, current] = await Promise.all([
      existingCredential
        ? Promise.resolve(existingCredential)
        : readCredentials(
            this.installation,
            this.environment,
            undefined,
            this.readSystemKeyOptions,
          ),
      readSelection(this.environment, family),
    ]);
    const channel = await readLoginChannel(credential);
    if (!channel || (channel !== family && !(channel === "zai_cn" && family === "bigmodel")))
      return;
    const userId = await readOAuthUserId(credential, channel);
    if (!userId) return;
    let identity = userId.trim();
    let linkedAccessToken: string | undefined;
    if (channel === "zai_cn") {
      // The CN token proves a login, but is not a BigModel business credential.
      if (!(await credential("oauth:zai_cn:access_token"))) return;
      const link = parseBigModelLink(await credential("oauth:linked_bigmodel"));
      if (link?.userId !== userId) return;
      identity = link.customerId;
      linkedAccessToken = plaintextCredential(link.accessToken);
    }
    const sessionRevision = await credential("oauth:session_revision");
    const account = JSON.stringify([channel, userId, identity, sessionRevision]);
    const project = await readProjectCredential(
      credential,
      family,
      identity,
      personalCodingPlanOrigin(family, this.environment),
      { userId, sessionRevision, linkedAccessToken },
    );
    const base = { identity, account, current };
    if (project) return { ...base, project };
    const key = `account-provider:coding-plan:${providerId}:account:${encodeURIComponent(identity)}:api-key`;
    return { ...base, apiKey: (await credential(key)).trim() };
  }

  async inspect(
    providerId: string,
    accountType: string,
    existingCredential?: CredentialReader,
  ): Promise<AccountState> {
    const family = familySchema.parse(accountType);
    this.#authorized.delete(providerId);
    this.issue = undefined;
    let current = false;
    try {
      const context = await this.#context(providerId, family, existingCredential);
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
      if (!context.project && !context.apiKey) {
        if (current)
          this.issue =
            "ZCode is signed in, but its Personal Coding Plan credentials are not initialized. Open the personal plan in ZCode Desktop, then re-detect ZCode. This does not mean the subscription is inactive.";
        return {
          ...base,
          availability: "unavailable",
          entitled: false,
          unavailableReason: "credential-failed",
        };
      }
      const apiKey = context.project
        ? await this.#projectToken.resolve(
            context.project,
            this.installation.version,
            new AbortController().signal,
          )
        : context.apiKey;
      const entitlement = await queryEntitlement(family, apiKey, this.environment);
      // A query may cross a Desktop account/selection/key change. Never publish mixed identities.
      const after = await this.#context(providerId, family);
      if (
        !after ||
        after.account !== context.account ||
        after.current !== current ||
        after.apiKey !== context.apiKey ||
        JSON.stringify(after.project) !== JSON.stringify(context.project)
      )
        return { availability: "unknown", entitled: false, current: false };
      if (entitlement === "available") {
        if (current) this.#authorized.set(providerId, { family, account: context.account });
        return { ...base, availability: "available", entitled: true };
      }
      if (current)
        this.issue =
          entitlement === "unavailable"
            ? "ZCode Personal Coding Plan subscription check found no active subscription. Check the selected account in ZCode Desktop, then re-detect ZCode."
            : "ZCode Personal Coding Plan credentials or subscription could not be verified. Open the personal plan in ZCode Desktop, then re-detect ZCode; subscription status is unknown.";
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
    } catch (error) {
      // Credential/profile reads can fail before #context returns its selection snapshot.
      current = await readSelection(this.environment, family).catch(() => false);
      if (current)
        this.issue =
          error instanceof ZcodeCredentialError
            ? `${error.message} Personal Coding Plan subscription status is unknown.`
            : "ZCode Personal Coding Plan credentials could not be read or verified. Open the personal plan in ZCode Desktop, then re-detect ZCode; subscription status is unknown.";
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
        expectedAccountScope: z.string().optional(),
        rejectedProjectTokenFingerprint: z.string().optional(),
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
    if (!context?.current || context.account !== authorized.account)
      throw new ZcodeError("authenticationRequired", CONNECT);
    if (context.project) {
      const { expectedAccountScope, rejectedProjectTokenFingerprint } = parsed.data;
      if (
        (expectedAccountScope !== undefined &&
          expectedAccountScope !== context.project.accountScope) ||
        (rejectedProjectTokenFingerprint && !expectedAccountScope)
      )
        throw new ZcodeError("authenticationRequired", CONNECT);
      const apiKey = await this.#projectToken.resolve(
        context.project,
        this.installation.version,
        signal,
        rejectedProjectTokenFingerprint,
      );
      const after = await this.#context(providerId, authorized.family);
      signal.throwIfAborted();
      if (
        !after?.current ||
        after.account !== context.account ||
        JSON.stringify(after.project) !== JSON.stringify(context.project)
      )
        throw new ZcodeError("authenticationRequired", CONNECT);
      return {
        apiKey,
        apiKeyId: context.project.location.apiKeyId,
        accountScope: context.project.accountScope,
      };
    }
    if (
      !context.apiKey ||
      parsed.data.expectedAccountScope !== undefined ||
      parsed.data.rejectedProjectTokenFingerprint
    )
      throw new ZcodeError("authenticationRequired", CONNECT);
    return { apiKey: context.apiKey };
  }
}
