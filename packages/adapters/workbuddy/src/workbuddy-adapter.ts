import {
  CodeBuddyAcpClient,
  CodeBuddyAdapter,
  type CodeBuddyAdapterOptions,
  type CodeBuddyClient,
} from "@codexhost/adapter-codebuddy";
import type {
  HarnessInspection,
  HarnessResult,
  HarnessSession,
  InspectHarnessInput,
  OpenSessionInput,
} from "@codexhost/harness-adapter";
import { harnessInspectionSchema } from "@codexhost/shared-contracts";
import { workBuddyInvocation } from "./command.js";
import { WORKBUDDY_RUNTIME_PROFILE } from "./common.js";
import {
  loadWorkBuddyProductModels,
  mergeWorkBuddyProductModels,
  type WorkBuddyProductModel,
} from "./product-models.js";

export type WorkBuddyAdapterOptions = Omit<
  CodeBuddyAdapterOptions,
  "profile" | "invocationFactory"
> & {
  productModels?: () => Promise<readonly WorkBuddyProductModel[]>;
  platform?: NodeJS.Platform;
  /** Seconds to wait for the user to finish a native browser/QR login before giving up. */
  authenticationTimeoutMs?: number;
};

/** The WorkBuddy CLI advertises exactly these methods (WeChat, external, iOA, selfhosted). */
const AUTHENTICATION_METHOD_ID = "internal";
const DEFAULT_AUTHENTICATION_TIMEOUT_MS = 10 * 60_000;

function isAuthenticationRequired(error: unknown): boolean {
  // super.inspect() reports failures as plain HarnessError objects, not Error instances.
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "authenticationRequired"
  );
}

export class WorkBuddyAdapter extends CodeBuddyAdapter {
  readonly #productModels: () => Promise<readonly WorkBuddyProductModel[]>;
  readonly #authenticationTimeoutMs: number;
  #authentication: Promise<boolean> | undefined;

  constructor(options: WorkBuddyAdapterOptions = {}) {
    const {
      productModels,
      authenticationTimeoutMs = DEFAULT_AUTHENTICATION_TIMEOUT_MS,
      ...codeBuddyOptions
    } = options;
    const environment = { ...(codeBuddyOptions.environment ?? process.env) };
    super({
      ...codeBuddyOptions,
      // Product-file Models stay selectable even when ACP omits them from option rows.
      profile: { ...WORKBUDDY_RUNTIME_PROFILE, allowUnlistedModelSelection: true },
      invocationFactory: workBuddyInvocation,
      clientFactory:
        codeBuddyOptions.clientFactory ??
        ((clientOptions) => new CodeBuddyAcpClient(clientOptions, undefined, workBuddyInvocation)),
    });
    this.#productModels = productModels ?? (() => loadWorkBuddyProductModels(environment));
    this.#authenticationTimeoutMs = authenticationTimeoutMs;
  }

  override async inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    let inspection = await super.inspect(input);
    if (inspection.status === "unavailable" && isAuthenticationRequired(inspection.error)) {
      // Requirement: an installed WorkBuddy must never strand the user on a manual
      // login. A silent native authenticate (browser/QR) runs once per adapter,
      // then inspection retries transparently; failure keeps the original result.
      if (await this.#authenticateOnce(input))
        inspection = await super.inspect({ ...input, refresh: true });
    }
    if (inspection.status !== "ready") return inspection;
    const productModels = await this.#productModels().catch(() => []);
    if (productModels.length === 0) return inspection;
    return harnessInspectionSchema.parse({
      ...inspection,
      catalog: mergeWorkBuddyProductModels(inspection.catalog, productModels),
    });
  }

  /** One in-flight native login per adapter; later callers await the same attempt. */
  #authenticateOnce(input: InspectHarnessInput): Promise<boolean> {
    const attempt = this.#authentication ?? this.#authenticate(input);
    this.#authentication = attempt.finally(() => {
      if (this.#authentication === attempt) this.#authentication = undefined;
    });
    return attempt;
  }

  async #authenticate(input: InspectHarnessInput): Promise<boolean> {
    const cwd = input.cwd ?? process.cwd();
    let client: CodeBuddyClient | undefined;
    try {
      client = this.#clientFactory()({
        cwd,
        environment: this.options.environment ?? process.env,
        ephemeral: true,
        handlers: {
          update: () => {},
          fault: () => {},
          permission: async () => ({ outcome: { outcome: "cancelled" } }),
          question: async () => ({ outcome: "cancelled" }),
        },
      });
      await client.initialize();
      if (!client.authenticate) return false;
      await client.authenticate({ methodId: AUTHENTICATION_METHOD_ID });
      return true;
    } catch {
      return false;
    } finally {
      await client?.close().catch(() => {});
    }
  }

  /** The parent keeps its factory private; mirror its defaulting rules exactly. */
  #clientFactory(): NonNullable<CodeBuddyAdapterOptions["clientFactory"]> {
    return (
      this.options.clientFactory ??
      ((clientOptions) => new CodeBuddyAcpClient(clientOptions, undefined, workBuddyInvocation))
    );
  }

  override async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (
      input.kind === "create" &&
      input.executionPolicy === "unattended-full-access" &&
      input.permissionModeId &&
      input.permissionModeId !== "fullAccess"
    ) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "WorkBuddy: unattended execution requires native fullAccess permissions",
          retryable: false,
        },
      };
    }
    return super.open(input);
  }
}
