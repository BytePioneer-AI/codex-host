import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HarnessCredentialTransfer } from "@codexhost/harness-adapter";

export async function readGrokCredentials(
  environment: NodeJS.ProcessEnv,
): Promise<HarnessCredentialTransfer[]> {
  if (
    [environment.XAI_API_KEY, environment.GROK_API_KEY, environment.GROK_TOKEN].some((v) =>
      v?.trim(),
    )
  )
    return [];
  try {
    const home = environment.GROK_HOME ?? path.join(environment.HOME ?? os.homedir(), ".grok");
    const auth = JSON.parse(await readFile(path.join(home, "auth.json"), "utf8"));
    const client = "b1a00492-073a-47ea-816f-4c329264a828";
    const entry = auth[`https://auth.x.ai::${client}`] ?? auth["https://auth.x.ai"];
    if (!entry || entry.oidc_issuer !== "https://auth.x.ai" || entry.oidc_client_id !== client)
      return [];
    if (
      ![entry.key, entry.refresh_token, entry.user_id].every(
        (v) => typeof v === "string" && v.length,
      )
    )
      return [];
    const expires = Date.parse(entry.expires_at);
    if (!Number.isFinite(expires)) return [];
    return [
      {
        source: {
          id: `grok:${createHash("sha256").update(entry.user_id).digest("hex")}`,
          harnessId: "grok",
          provider: "xai",
          label: typeof entry.email === "string" && entry.email ? entry.email : "Grok",
        },
        oauth: { access: entry.key, refresh: entry.refresh_token, expires: expires - 300_000 },
      },
    ];
  } catch {
    return [];
  }
}
