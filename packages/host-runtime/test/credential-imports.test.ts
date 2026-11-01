import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessAdapter } from "@codexhost/harness-adapter";
import { handleCredentialImports } from "../src/credential-imports.js";
import { readCodexCredential } from "../src/account/codex-credential-export.js";
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true })));
});
function jwt(value: object) {
  return `header.${Buffer.from(JSON.stringify(value)).toString("base64url")}.signature`;
}
async function setup() {
  const home = await mkdtemp(path.join(os.tmpdir(), "credential-host-"));
  homes.push(home);
  const codex = path.join(home, ".codex");
  await mkdir(codex);
  await writeFile(
    path.join(codex, "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: jwt({
          client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
          exp: 2000000000,
          sub: "user-a",
          "https://api.openai.com/auth": { chatgpt_account_id: "account-a" },
        }),
        refresh_token: "secret-refresh",
        account_id: "account-a",
        id_token: jwt({ email: "a@example.com" }),
      },
    }),
  );
  return { HOME: home, CODEX_HOME: codex };
}
function target() {
  const add = vi.fn(async () => {});
  const remove = vi.fn(async () => {});
  const adapter = {
    harnessId: "pi",
    credentialImports: { providers: ["openai-codex", "xai"], list: async () => [], add, remove },
  } as unknown as HarnessAdapter;
  return { adapter, add, remove };
}
describe("credential import routing", () => {
  it("returns only metadata and requires a fresh matching source on write", async () => {
    const env = await setup();
    const { adapter, add } = target();
    const result = await handleCredentialImports({ request: { action: "list" } }, [adapter], env);
    expect(result.sources[0]).toMatchObject({ harnessId: "codex", label: "a@example.com" });
    expect(JSON.stringify(result)).not.toMatch(/secret-refresh|access_token|oauth|signature/);
    const sourceId = result.sources[0]?.id;
    if (!sourceId) throw new Error("Expected source account");
    await handleCredentialImports(
      {
        targetHarnessId: "pi",
        request: { action: "import", sourceId, name: "codex", confirmed: true },
      },
      [adapter],
      env,
    );
    expect(add).toHaveBeenCalledOnce();
    expect(add.mock.calls[0]).toMatchObject(["codex", { oauth: { refresh: "secret-refresh" } }]);
    await writeFile(path.join(env.CODEX_HOME, "auth.json"), "{}");
    await expect(
      handleCredentialImports(
        {
          targetHarnessId: "pi",
          request: { action: "import", sourceId, name: "other", confirmed: true },
        },
        [adapter],
        env,
      ),
    ).rejects.toThrow("Source login changed");
    expect(add).toHaveBeenCalledOnce();
  });
  it("rejects unconfirmed operations and unknown fields", async () => {
    const env = await setup();
    const { adapter, add } = target();
    await expect(
      handleCredentialImports(
        { targetHarnessId: "pi", request: { action: "import", sourceId: "x", name: "codex" } },
        [adapter],
        env,
      ),
    ).rejects.toThrow();
    await expect(
      handleCredentialImports({ request: { action: "list", token: "secret" } }, [adapter], env),
    ).rejects.toThrow();
    expect(add).not.toHaveBeenCalled();
  });
  it("removes imported entries even after the source has logged out", async () => {
    const env = await setup();
    const { adapter, remove } = target();
    await writeFile(path.join(env.CODEX_HOME, "auth.json"), "{}");
    await handleCredentialImports(
      { targetHarnessId: "pi", request: { action: "remove", name: "codex", confirmed: true } },
      [adapter],
      env,
    );
    expect(remove).toHaveBeenCalledWith("codex");
  });
  it("lists the target's other logins and never lets a failure there hide the imports", async () => {
    const env = await setup();
    const { adapter } = target();
    const others = [{ provider: "anthropic", type: "oauth" as const }];
    (adapter as unknown as { credentialImports: object }).credentialImports = {
      providers: ["openai-codex", "xai"],
      list: async () => [],
      listOthers: async () => others,
    };
    const listed = await handleCredentialImports({ request: { action: "list" } }, [adapter], env);
    expect(listed.targets[0]?.others).toEqual(others);
    (adapter as unknown as { credentialImports: object }).credentialImports = {
      providers: ["openai-codex", "xai"],
      list: async () => [],
      listOthers: async () => {
        throw new Error("boom");
      },
    };
    const failed = await handleCredentialImports({ request: { action: "list" } }, [adapter], env);
    expect(failed.targets).toHaveLength(1);
    expect(failed.targets[0]?.others).toEqual([]);
  });
  it("does not export API-key credentials or mismatched account tokens", async () => {
    const env = await setup();
    const filename = path.join(env.CODEX_HOME, "auth.json");
    await writeFile(filename, JSON.stringify({ OPENAI_API_KEY: "secret" }));
    expect(await readCodexCredential(env)).toEqual([]);
    await writeFile(filename, "not json");
    expect(await readCodexCredential(env)).toEqual([]);
  });
});
