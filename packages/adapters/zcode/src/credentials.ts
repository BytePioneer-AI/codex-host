import { createDecipheriv, createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { homedir, platform, userInfo } from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  invalidateSystemCredentialKey,
  KeychainReadTimeout,
  readSystemCredentialKey,
  type ReadSystemKey,
  type ReadSystemKeyOptions,
} from "./credential-keyring.js";
import { ZcodeError } from "./errors.js";
import type { ZcodeInstallation } from "./installation.js";

const V1 = "enc:v1:";
const V2 = "enc:v2:";
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest();
const storeSchema = z.record(z.string(), z.string());

export class ZcodeCredentialError extends ZcodeError {
  constructor(message: string) {
    super("authenticationRequired", message, true);
  }
}

const invalidV2 = () =>
  new ZcodeCredentialError(
    "Cannot decrypt ZCode enc:v2: credentials: invalid or damaged encrypted record.",
  );
const unavailableV2 = () =>
  new ZcodeCredentialError(
    "Cannot read ZCode enc:v2: credentials: the original key is unavailable or does not match. Check the ZCode credential storage in the Host user's session.",
  );

function decryptGcm(iv: Buffer, tag: Buffer, data: Buffer, key: Buffer) {
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: tag.length });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

function decryptV1(value: string, environment: NodeJS.ProcessEnv) {
  let username = "unknown";
  try {
    username = userInfo().username;
  } catch {
    // ZCode derives the same fallback when the platform has no user record.
  }
  const secret =
    environment.ZCODE_CREDENTIAL_SECRET ||
    `zcode-credential-fallback:${platform()}:${environment.HOME || homedir()}:${username}`;
  const [iv, tag, data, extra] = value.slice(V1.length).split(".");
  try {
    if (!iv || !tag || !data || extra !== undefined) throw new Error();
    const authTag = Buffer.from(tag, "base64url");
    if (authTag.length !== 16) throw new Error();
    return decryptGcm(
      Buffer.from(iv, "base64url"),
      authTag,
      Buffer.from(data, "base64url"),
      digest(secret),
    ).trim();
  } catch {
    throw new ZcodeCredentialError(
      "Cannot decrypt ZCode credentials; ZCODE_CREDENTIAL_SECRET must match ZCode Desktop",
    );
  }
}

function decodeSegment(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw invalidV2();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw invalidV2();
  return bytes;
}

type KeySource = "os" | "env";
type KeyMaterial = { source: KeySource; key: Buffer; account?: string };
async function decryptV2(value: string, getKey: () => Promise<KeyMaterial>) {
  const [source, fingerprint, payload, extra] = value.slice(V2.length).split(":");
  if (
    (source !== "os" && source !== "env") ||
    !fingerprint ||
    !/^[a-f0-9]{24}$/.test(fingerprint) ||
    !payload ||
    extra !== undefined
  )
    throw invalidV2();
  const [encodedIv, encodedTag, encodedData, extraSegment] = payload.split(".");
  if (!encodedIv || !encodedTag || encodedData === undefined || extraSegment !== undefined)
    throw invalidV2();
  const iv = decodeSegment(encodedIv);
  const tag = decodeSegment(encodedTag);
  const data = decodeSegment(encodedData);
  if (iv.length !== 12 || tag.length !== 16) throw invalidV2();
  const material = await getKey();
  const { key } = material;
  if (source !== material.source || digest(key).toString("hex").slice(0, 24) !== fingerprint) {
    if (material.account) invalidateSystemCredentialKey(material.account);
    throw unavailableV2();
  }
  try {
    return decryptGcm(iv, tag, data, key);
  } catch {
    throw invalidV2();
  }
}

async function readSecretFile(file: string, implicit: boolean) {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size < 32 ||
      stat.size > 4096 ||
      (implicit && process.platform !== "win32" && (stat.mode & 0o077) !== 0)
    )
      throw unavailableV2();
    const secret = await handle.readFile("utf8");
    const length = Buffer.byteLength(secret, "utf8");
    if (length < 32 || length > 4096) throw unavailableV2();
    return secret;
  } finally {
    await handle.close();
  }
}

/** ZCode v3.18.2 source selection, without initialization, migration or keyring locks. */
async function loadV2Key(
  file: string,
  values: Record<string, string>,
  environment: NodeJS.ProcessEnv,
  readSystemKey: ReadSystemKey,
  readSystemKeyOptions?: ReadSystemKeyOptions,
): Promise<KeyMaterial> {
  try {
    const secret = environment.ZCODE_CREDENTIAL_SECRET;
    const explicitFile = environment.ZCODE_CREDENTIAL_SECRET_FILE;
    if (secret && explicitFile) throw unavailableV2();
    if (secret) return { source: "env", key: digest(secret) };
    if (explicitFile)
      return { source: "env", key: digest(await readSecretFile(explicitFile, false)) };
    const directory = path.dirname(file);
    const marker = await readFile(path.join(directory, "credential-source"), "utf8").catch(
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (marker !== undefined && marker !== "os\n") throw unavailableV2();
    const hasOsEnvelope = Object.values(values).some((value) => value.startsWith(`${V2}os:`));
    if (!hasOsEnvelope) {
      if (marker) throw unavailableV2();
      return {
        source: "env",
        key: digest(await readSecretFile(path.join(directory, "credential-secret"), true)),
      };
    }
    const account = digest(file).toString("hex");
    const encoded = readSystemKeyOptions
      ? await readSystemKey(account, readSystemKeyOptions)
      : await readSystemKey(account);
    if (!encoded || encoded.length !== 43) throw unavailableV2();
    const key = decodeSegment(encoded);
    if (key.length !== 32) throw unavailableV2();
    return { source: "os", key, account };
  } catch (error) {
    if (error instanceof KeychainReadTimeout)
      throw new ZcodeCredentialError(
        "ZCode could not read credentials: macOS Keychain read timed out. If macOS prompts you, allow access to ZCode Credential Encryption, then re-detect ZCode.",
      );
    throw unavailableV2();
  }
}

/** Apply the same fail-closed check to credentials nested inside decoded JSON. */
export function plaintextCredential(value: string): string {
  if (/^\s*(?:Bearer\s+)*enc:/i.test(value))
    throw new ZcodeCredentialError(
      "Cannot read ZCode credentials: unsupported encrypted credential format (enc:).",
    );
  return value;
}

/** Read one immutable file snapshot; decrypt only requested keys, never write the shared store. */
export async function readCredentials(
  installation: ZcodeInstallation,
  environment: NodeJS.ProcessEnv,
  readSystemKey = readSystemCredentialKey,
  readSystemKeyOptions?: ReadSystemKeyOptions,
): Promise<(key: string) => Promise<string>> {
  const file = path.resolve(installation.dataRoot, "credentials.json");
  let values: Record<string, string>;
  try {
    values = storeSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return async () => "";
    throw new ZcodeCredentialError("Cannot read ZCode credentials.");
  }
  let keyMaterial: Promise<KeyMaterial> | undefined;
  return async (key) => {
    const value = Object.hasOwn(values, key) ? values[key] : undefined;
    if (value === undefined) return "";
    return plaintextCredential(
      value.startsWith(V1)
        ? decryptV1(value, environment)
        : value.startsWith(V2)
          ? await decryptV2(
              value,
              () =>
                (keyMaterial ??= loadV2Key(
                  file,
                  values,
                  environment,
                  readSystemKey,
                  readSystemKeyOptions,
                )),
            )
          : value,
    );
  };
}
