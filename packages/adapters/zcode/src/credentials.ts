import { createDecipheriv, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir, platform, userInfo } from "node:os";
import path from "node:path";
import { z } from "zod";
import { ZcodeError } from "./errors.js";
import type { ZcodeInstallation } from "./installation.js";

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

/** Read one immutable file snapshot; decrypt only requested keys, never write the shared store. */
export async function readCredentials(
  installation: ZcodeInstallation,
  environment: NodeJS.ProcessEnv,
): Promise<(key: string) => string> {
  let store: unknown;
  try {
    store = JSON.parse(
      await readFile(path.join(installation.dataRoot, "credentials.json"), "utf8"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return () => "";
    throw new ZcodeError("authenticationRequired", "Cannot read ZCode credentials");
  }
  const values = z.record(z.string(), z.string()).safeParse(store).data;
  return (key) => {
    const value = values?.[key];
    return value ? decrypt(value, environment) : "";
  };
}

export async function readCredential(
  installation: ZcodeInstallation,
  environment: NodeJS.ProcessEnv,
  key: string,
): Promise<string> {
  return (await readCredentials(installation, environment))(key);
}
