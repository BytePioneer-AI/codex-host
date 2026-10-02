/** Native DSH Desktop browser-session authentication (DSH 0.2.0-rc.2). */
import { createHash, createHmac } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseDocument } from "yaml";

import { parseDeepSeekEndpoint } from "./generation-selector.js";

export type DeepSeekConnectionMode = "auto" | "web" | "desktop";
export const DEFAULT_DESKTOP_ENDPOINT = "http://127.0.0.1:19387/";

export async function resolveDesktopEndpoint(
  command: string,
  mode: DeepSeekConnectionMode = "auto",
  endpoint?: string,
): Promise<string | undefined> {
  if (!["auto", "web", "desktop"].includes(mode)) {
    throw new Error("DeepSeek connection mode must be auto, web, or desktop");
  }
  if (mode === "web") return undefined;
  if (mode === "auto") {
    // The Desktop-installed public CLI resolves through its installation symlink.
    const resolved = await realpath(command).catch(() => "");
    if (
      !/\.app\/Contents\/Resources\/runtime\/cli\/bin\/dsh$/u.test(resolved.replaceAll("\\", "/"))
    ) {
      return undefined;
    }
  }
  return parseDeepSeekEndpoint(endpoint ?? DEFAULT_DESKTOP_ENDPOINT);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read only the native browser-session grant; never create or change credentials. */
export async function desktopCookieSigner(
  endpoint: string,
  environment: NodeJS.ProcessEnv,
): Promise<() => string> {
  const origin = new URL(parseDeepSeekEndpoint(endpoint));
  const configured = environment.DSH_HOME?.trim();
  const home = configured
    ? path.resolve(configured === "~" ? homedir() : configured.replace(/^~[/\\]/u, `${homedir()}/`))
    : path.join(homedir(), ".dsh");
  const file = await open(path.join(home, ".credentials.yaml"), "r");
  let secret: Buffer;
  try {
    const metadata = await file.stat();
    if (
      !metadata.isFile() ||
      metadata.size > 256 * 1024 ||
      (process.platform !== "win32" &&
        ((metadata.mode & 0o077) !== 0 || metadata.uid !== process.getuid?.()))
    )
      throw new Error("DeepSeek Desktop credentials require an owner-only regular file");
    const document = parseDocument(await file.readFile("utf8"));
    if (document.errors.length) throw new Error("DeepSeek Desktop credentials are invalid");
    const value: unknown = document.toJS({ maxAliasCount: 10 });
    const grant =
      record(value) && value.version === 1 && record(value.records)
        ? value.records["client-connection/browser-session"]
        : undefined;
    const payload = record(grant) && grant.kind === "grant" ? grant.payload : undefined;
    if (
      !record(payload) ||
      payload.version !== 1 ||
      typeof payload.secret !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(payload.secret)
    ) {
      throw new Error("DeepSeek Desktop browser-session grant is missing or unsupported");
    }
    secret = Buffer.from(payload.secret, "base64url");
    if (secret.length !== 32 || secret.toString("base64url") !== payload.secret) {
      throw new Error("DeepSeek Desktop browser-session grant is invalid");
    }
  } finally {
    await file.close();
  }
  const name = `dsh-auth-${createHash("sha256").update(origin.host).digest("base64url")}`;
  return () => {
    const issuedAt = Date.now();
    const body = Buffer.from(
      JSON.stringify({
        version: 1,
        authority: origin.host,
        issuedAt,
        expiresAt: issuedAt + 60 * 60 * 1000,
      }),
    ).toString("base64url");
    return `${name}=v1.${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
  };
}
