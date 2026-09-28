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

/** `provider/updateAccountConfig` params: the Start Plan overlay for the signed-in account family. */
export async function accountConfig(
  installation: ZcodeInstallation,
  environment: NodeJS.ProcessEnv,
) {
  const file = installation.builtinProviderConfig;
  const builtin = builtinSchema.parse(JSON.parse(await readFile(file, "utf8")));
  // The CLI keeps its previous registry unless this matches its own Built-in layer revision.
  const basedOnZCodeBuiltinRevision = `zcode-builtin:${builtin.revision}:${createHash("sha256")
    .update(path.resolve(file))
    .digest("hex")}`;
  const family = await readCredential(installation, environment, "oauth:active_provider");
  const providers: Record<string, unknown> = {};
  const states: Record<string, unknown> = {};
  for (const rule of builtin.config.providerConfigRules.providerRules) {
    const access = rule.config.access;
    if (!family || access?.mode !== "start-plan" || access.accountType !== family) continue;
    providers[rule.providerId] = {
      builtinModelIds: rule.config.builtinModelIds ?? [],
      access: { type: "zhipu-account", entitled: true },
    };
    states[rule.providerId] = { availability: "available", entitled: true, current: true };
  }
  return {
    revision: `codexhost:${family || "signed-out"}:${builtin.revision}`,
    basedOnZCodeBuiltinRevision,
    providers,
    states,
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
