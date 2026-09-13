import { z } from "zod";

import { codexAccountPlanTypeSchema, type CodexAccountPlanType } from "@codexhost/shared-contracts";

const text = z.string().min(1).max(4_096);
export const codexCredentialIdentitySchema = z
  .object({
    issuer: z.literal("https://auth.openai.com"),
    subject: text,
    workspaceId: text,
  })
  .strict();
export type CodexCredentialIdentity = z.infer<typeof codexCredentialIdentitySchema>;

const claimsSchema = z.object({
  iss: z.literal("https://auth.openai.com"),
  sub: text,
  email: z.string().email().optional(),
  exp: z.number().int().nonnegative().optional(),
  "https://api.openai.com/auth": z
    .object({
      chatgpt_account_id: text.optional(),
      chatgpt_plan_type: z.string().optional(),
    })
    .optional(),
});
const documentSchema = z.object({
  auth_mode: z.literal("chatgpt").optional(),
  OPENAI_API_KEY: z.null().optional(),
  tokens: z.object({
    id_token: z.string().min(1),
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    account_id: text.optional(),
  }),
  last_refresh: z.string().optional(),
});

export class InvalidNativeCodexCredentialsError extends Error {
  constructor() {
    // Never attach a parser cause: it can contain credential input.
    super("Native Codex credentials are invalid or unsupported");
    this.name = "InvalidNativeCodexCredentialsError";
  }
}

export function sameCodexCredentialIdentity(
  left: CodexCredentialIdentity,
  right: CodexCredentialIdentity,
): boolean {
  return (
    left.issuer === right.issuer &&
    left.subject === right.subject &&
    left.workspaceId === right.workspaceId
  );
}

function claims(token: string): z.infer<typeof claimsSchema> {
  const parts = token.split(".");
  const payload = parts[1];
  if (!payload || parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/u.test(part))) {
    throw new InvalidNativeCodexCredentialsError();
  }
  return claimsSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
}

/**
 * Native file contents are opaque secrets; JSON/inspect never serialize them.
 * Decoding claims establishes association only, NOT signature or login verification.
 * The official backend must authenticate and confirm identity before committing it.
 */
export interface ManagedCodexOAuthCredential {
  accessToken: string;
  refreshToken: string;
  chatgptAccountId: string;
  expiresAtUnix: number | undefined;
}

export class NativeCodexCredentials {
  readonly identity: Readonly<CodexCredentialIdentity>;
  readonly email: string | undefined;
  readonly planType: CodexAccountPlanType | undefined;
  readonly #nativeDocument: string;

  private constructor(input: {
    identity: CodexCredentialIdentity;
    email?: string;
    planType?: CodexAccountPlanType;
    nativeDocument: string;
  }) {
    this.identity = Object.freeze({ ...input.identity });
    this.email = input.email;
    this.planType = input.planType;
    this.#nativeDocument = input.nativeDocument;
  }

  static parse(serialized: string): NativeCodexCredentials {
    try {
      if (Buffer.byteLength(serialized, "utf8") > 262_144) {
        throw new InvalidNativeCodexCredentialsError();
      }
      const document = documentSchema.parse(JSON.parse(serialized));
      const id = claims(document.tokens.id_token);
      const access = claims(document.tokens.access_token);
      const workspaceIds = [
        document.tokens.account_id,
        id["https://api.openai.com/auth"]?.chatgpt_account_id,
        access["https://api.openai.com/auth"]?.chatgpt_account_id,
      ].filter((value): value is string => value !== undefined);
      const workspaceId = workspaceIds[0];
      if (
        id.iss !== access.iss ||
        id.sub !== access.sub ||
        !workspaceId ||
        workspaceIds.some((value) => value !== workspaceId)
      ) {
        throw new InvalidNativeCodexCredentialsError();
      }
      const plan = codexAccountPlanTypeSchema.safeParse(
        access["https://api.openai.com/auth"]?.chatgpt_plan_type,
      );
      return new NativeCodexCredentials({
        identity: { issuer: id.iss, subject: id.sub, workspaceId },
        ...(id.email ? { email: id.email } : {}),
        ...(plan.success ? { planType: plan.data } : {}),
        // Preserve refresh tokens and unknown native fields byte-for-byte.
        nativeDocument: serialized,
      });
    } catch {
      throw new InvalidNativeCodexCredentialsError();
    }
  }

  /** Private Host services only. Callers must never log or expose this value. */
  managedOAuthCredential(): ManagedCodexOAuthCredential {
    try {
      const document = documentSchema.parse(JSON.parse(this.#nativeDocument));
      const access = claims(document.tokens.access_token);
      return {
        accessToken: document.tokens.access_token,
        refreshToken: document.tokens.refresh_token,
        chatgptAccountId: this.identity.workspaceId,
        expiresAtUnix: access.exp,
      };
    } catch {
      throw new InvalidNativeCodexCredentialsError();
    }
  }

  /** Preserve unknown native fields while atomically advancing an OAuth credential. */
  withRefreshedOAuthTokens(input: {
    accessToken: string;
    idToken?: string;
    refreshToken?: string;
    refreshedAt?: Date;
  }): NativeCodexCredentials {
    try {
      const document = JSON.parse(this.#nativeDocument) as Record<string, unknown>;
      const tokens = document.tokens;
      if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) {
        throw new InvalidNativeCodexCredentialsError();
      }
      const nextTokens = { ...(tokens as Record<string, unknown>) };
      nextTokens.access_token = input.accessToken;
      if (input.idToken !== undefined) nextTokens.id_token = input.idToken;
      if (input.refreshToken !== undefined) nextTokens.refresh_token = input.refreshToken;
      const next = {
        ...document,
        tokens: nextTokens,
        last_refresh: (input.refreshedAt ?? new Date()).toISOString(),
      };
      const refreshed = NativeCodexCredentials.parse(JSON.stringify(next));
      if (!sameCodexCredentialIdentity(refreshed.identity, this.identity)) {
        throw new InvalidNativeCodexCredentialsError();
      }
      return refreshed;
    } catch {
      throw new InvalidNativeCodexCredentialsError();
    }
  }

  /** Only the private native-file persistence boundary should consume this value. */
  serializeForNativeStore(): string {
    return this.#nativeDocument;
  }
}
