import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parse } from "smol-toml";

/**
 * Devin 3000.11+ requires an explicit ACP `authenticate` call carrying the
 * user's API key in `_meta.api_key`; the only alternative advertised by the
 * agent is a PKCE browser flow that must never be triggered implicitly.
 * `devin auth login` stores that key in credentials.toml, so the adapter reads
 * it back and hands it to Devin's own handshake — it is never sent elsewhere.
 */
export async function devinApiKey(environment: NodeJS.ProcessEnv): Promise<string | undefined> {
  const explicit = environment.CODEXHOST_DEVIN_API_KEY?.trim() || environment.DEVIN_API_KEY?.trim();
  if (explicit) return explicit;
  try {
    const file = path.join(
      environment.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"),
      "devin",
      "credentials.toml",
    );
    const parsed = parse(await readFile(file, "utf8"));
    const key = parsed["windsurf_api_key"];
    return typeof key === "string" && key.trim() ? key.trim() : undefined;
  } catch {
    return undefined;
  }
}
