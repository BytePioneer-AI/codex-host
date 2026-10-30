import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HarnessCredentialTransfer } from "@codexhost/harness-adapter";

/** Read-only native Codex source. Keychain/API-key configurations are not exported. */
export async function readCodexCredential(
  environment: NodeJS.ProcessEnv,
): Promise<HarnessCredentialTransfer[]> {
  try {
    const home = environment.CODEX_HOME ?? path.join(environment.HOME ?? os.homedir(), ".codex");
    const auth = JSON.parse(await readFile(path.join(home, "auth.json"), "utf8"));
    if (auth.OPENAI_API_KEY || (auth.auth_mode && auth.auth_mode !== "chatgpt")) return [];
    const t = auth.tokens;
    if (
      !t ||
      ![t.access_token, t.refresh_token, t.account_id].every(
        (v) => typeof v === "string" && v.length,
      )
    )
      return [];
    const claims = JSON.parse(Buffer.from(t.access_token.split(".")[1], "base64url").toString());
    if (claims.client_id !== "app_EMoamEEZ73f0CkXaXp7hrann" || !Number.isFinite(claims.exp * 1000))
      return [];
    const account = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (account !== t.account_id) return [];
    let email: unknown;
    try {
      email = JSON.parse(Buffer.from(t.id_token.split(".")[1], "base64url").toString()).email;
    } catch {
      /* Optional label only. */
    }
    const identity = `${t.account_id}:${claims.sub ?? ""}`;
    return [
      {
        source: {
          id: `codex:${createHash("sha256").update(identity).digest("hex")}`,
          harnessId: "codex",
          provider: "openai-codex",
          label: typeof email === "string" && email ? email : "Codex",
        },
        oauth: {
          access: t.access_token,
          refresh: t.refresh_token,
          expires: claims.exp * 1000,
          accountId: t.account_id,
        },
      },
    ];
  } catch {
    return [];
  }
}
