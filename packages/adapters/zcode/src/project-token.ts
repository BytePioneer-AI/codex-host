import { createHash } from "node:crypto";
import { z } from "zod";
import { ZcodeError } from "./errors.js";

const locationSchema = z.object({
  organizationId: z.string().trim().min(1),
  projectId: z.string().trim().min(1),
  apiKeyId: z.string().trim().min(1),
});
export interface ProjectCredential {
  origin: string;
  loginToken: string;
  location: z.infer<typeof locationSchema>;
  accountScope: string;
}

/** Read only Desktop's exact personal project locator; never select a Team or create a key. */
export function readProjectCredential(
  credential: (key: string) => string,
  family: "zai" | "bigmodel",
  identity: string,
  origin: string,
): ProjectCredential | undefined {
  const key = `project-key-location:v1:${encodeURIComponent(
    JSON.stringify([origin, family, identity, null, 1, "non-team"]),
  )}`;
  const raw = credential(key);
  if (!raw) return undefined;
  const location = locationSchema.parse(JSON.parse(raw));
  const login = credential(`oauth:${family}:access_token`).trim();
  const loginToken = login.replace(/^Bearer\s+/i, "").trim();
  if (!loginToken) throw projectCredentialError();
  // Match Desktop's account scope used by the CLI's rejected-token retry protocol.
  const accountScope = createHash("sha256")
    .update(
      JSON.stringify([
        family,
        "individual-coding-plan",
        null,
        login,
        credential("zcodejwttoken").trim() || null,
      ]),
    )
    .digest("hex");
  return { origin, loginToken, location, accountScope };
}

const tokenSchema = z.object({
  success: z.boolean().optional(),
  code: z.union([z.literal(0), z.literal(200), z.literal("0"), z.literal("200")]),
  data: z.object({
    enable: z.boolean().optional(),
    accessToken: z.string().trim().min(1),
    tokenType: z.literal("Bearer"),
    expiresIn: z.number().finite().positive(),
    expiresAt: z.number().finite().positive(),
  }),
});

export function projectCredentialError() {
  return new ZcodeError(
    "authenticationRequired",
    "ZCode Personal Coding Plan project credentials are unavailable. Open the personal plan in ZCode Desktop, then re-detect ZCode and reopen the Thread",
  );
}

/** On-demand, per-transport cache. Tokens never enter settings, overlays, history or logs. */
export class ProjectToken {
  #cached: { scope: string; token: string; expiresAt: number; fingerprint: string } | undefined;

  async resolve(
    credential: ProjectCredential,
    appVersion: string,
    signal: AbortSignal,
    rejectedFingerprint?: string,
  ) {
    signal.throwIfAborted();
    const scope = createHash("sha256").update(JSON.stringify(credential)).digest("hex");
    const cached = this.#cached;
    if (
      cached?.scope === scope &&
      cached.fingerprint !== rejectedFingerprint &&
      cached.expiresAt > Date.now() + 120_000
    )
      return cached.token;
    this.#cached = undefined;
    const { origin, location, loginToken } = credential;
    const url = `${origin}/api/biz/v1/organization/${encodeURIComponent(location.organizationId)}/projects/${encodeURIComponent(location.projectId)}/api_keys/${encodeURIComponent(location.apiKeyId)}/access_tokens`;
    const started = Date.now();
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${loginToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ clientType: "zcode", clientVersion: appVersion }),
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
      if (!response.ok) throw projectCredentialError();
      const parsed = tokenSchema.safeParse(await response.json());
      if (!parsed.success || parsed.data.success === false || parsed.data.data.enable === false)
        throw projectCredentialError();
      const data = parsed.data.data;
      const expiresAt = Math.min(data.expiresAt * 1000, started + data.expiresIn * 1000);
      signal.throwIfAborted();
      if (expiresAt <= Date.now()) throw projectCredentialError();
      this.#cached = {
        scope,
        token: data.accessToken,
        expiresAt,
        fingerprint: createHash("sha256").update(data.accessToken).digest("hex"),
      };
      return data.accessToken;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ZcodeError) throw error;
      if (error instanceof Error && error.name === "TimeoutError")
        throw new ZcodeError(
          "unavailable",
          "ZCode project token request timed out. Try again.",
          true,
        );
      // Native errors and response bodies may contain a credential or access-bearing URL.
      throw projectCredentialError();
    }
  }
}
