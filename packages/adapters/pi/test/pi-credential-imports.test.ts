import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPiCredentialImports } from "../src/pi-credential-imports.js";
import type { HarnessCredentialTransfer } from "@codexhost/harness-adapter";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
const credential: HarnessCredentialTransfer = {
  source: {
    id: "codex:account-a",
    harnessId: "codex",
    provider: "openai-codex",
    label: "a@example.com",
  },
  oauth: {
    access: "access-secret",
    refresh: "refresh-secret",
    expires: 2000000000000,
    accountId: "a",
  },
};
function setup(failWrite = false) {
  const home = mkdtempSync(path.join(os.tmpdir(), "pi-import-test-"));
  homes.push(home);
  const authPath = path.join(home, "auth.json");
  writeFileSync(authPath, JSON.stringify({ "openai-codex": { type: "api_key", key: "existing" } }));
  const original = readFileSync(authPath, "utf8");
  const imports = createPiCredentialImports({
    environment: { PI_CODING_AGENT_DIR: home },
    ...(failWrite
      ? {
          writeAuth: () => {
            throw new Error("Disk full");
          },
        }
      : {}),
    resolveInstallation: async () => ({
      providerModules: {
        "openai-codex": "file:///installed/pi/openai-codex.js",
        xai: "file:///installed/pi/xai.js",
      },
      reservedNames: ["openai-codex", "xai"],
      configuredProviderNames: async () => ["extension-only"],
      backend: {
        withLock(fn) {
          const result = fn(readFileSync(authPath, "utf8"));
          if (result.next !== undefined) {
            if (failWrite) throw new Error("Disk full");
            writeFileSync(authPath, result.next);
          }
          return result.result;
        },
      },
    }),
  });
  return { home, authPath, original, imports };
}
describe("Pi credential imports", () => {
  it("adds an independent provider and never takes ownership of existing auth", async () => {
    const { home, authPath, imports } = setup();
    await imports.add("codex", credential);
    const auth = JSON.parse(readFileSync(authPath, "utf8"));
    expect(auth["openai-codex"]).toEqual({ type: "api_key", key: "existing" });
    expect(auth.codex).toMatchObject({ type: "oauth", ...credential.oauth });
    const records = await imports.list();
    expect(records).toEqual([
      expect.objectContaining({ name: "codex", source: credential.source }),
    ]);
    const extension = readFileSync(
      path.join(home, "extensions/codexhost-account-codex/index.ts"),
      "utf8",
    );
    expect(extension).toContain("openaiCodexProvider()");
    expect(extension).toContain("codexhostImportId");
    expect(extension).not.toContain("access-secret");
    expect(JSON.stringify(records)).not.toContain("secret");
    await imports.remove("codex");
    expect(JSON.parse(readFileSync(authPath, "utf8"))).toEqual({
      "openai-codex": { type: "api_key", key: "existing" },
    });
    expect(await imports.list()).toEqual([]);
  });
  it("reimports only the same source into an owned entry", async () => {
    const { authPath, imports } = setup();
    await imports.add("codex", credential);
    await imports.reimport("codex", {
      ...credential,
      oauth: { ...credential.oauth, access: "new-access" },
    });
    const auth = JSON.parse(readFileSync(authPath, "utf8"));
    expect(auth.codex.access).toBe("new-access");
    expect(auth["openai-codex"]).toEqual({ type: "api_key", key: "existing" });
    await expect(
      imports.reimport("codex", {
        ...credential,
        source: { ...credential.source, id: "other-account" },
      }),
    ).rejects.toThrow();
  });
  it("rejects duplicate, built-in and configured provider names", async () => {
    const { home, authPath, imports } = setup();
    await expect(imports.add("openai-codex", credential)).rejects.toThrow();
    await expect(imports.add("extension-only", credential)).rejects.toThrow();
    writeFileSync(
      path.join(home, "models.json"),
      JSON.stringify({ providers: { custom: { models: [] } } }),
    );
    await expect(imports.add("custom", credential)).rejects.toThrow();
    await imports.add("codex", credential);
    const before = readFileSync(authPath, "utf8");
    await expect(imports.add("codex", credential)).rejects.toThrow();
    expect(readFileSync(authPath, "utf8")).toBe(before);
  });
  it("refuses path traversal and preserves externally edited configurations", async () => {
    const { home, authPath, imports } = setup();
    await expect(imports.add("../escape", credential)).rejects.toThrow();
    await imports.add("codex", credential);
    writeFileSync(path.join(home, "extensions/codexhost-account-codex/index.ts"), "// user edit");
    // An externally edited import stops being ours: it leaves the list and writes are refused.
    expect(await imports.list()).toEqual([]);
    expect((await imports.listOthers?.())?.map((login) => login.provider)).toContain("codex");
    const before = readFileSync(authPath, "utf8");
    await expect(imports.remove("codex")).rejects.toThrow();
    expect(readFileSync(authPath, "utf8")).toBe(before);
  });
  it("cleans up newly created files when the credential write fails", async () => {
    const { home, authPath, imports, original } = setup(true);
    await expect(imports.add("codex", credential)).rejects.toThrow("Disk full");
    expect(readFileSync(authPath, "utf8")).toBe(original);
    expect(existsSync(path.join(home, "extensions/codexhost-account-codex"))).toBe(false);
  });
  it("preserves user-added files during removal and supports Grok without API-key fallback", async () => {
    const { home, imports } = setup();
    await imports.add("grok", {
      ...credential,
      source: { ...credential.source, harnessId: "grok", provider: "xai" },
    });
    const dir = path.join(home, "extensions/codexhost-account-grok");
    mkdirSync(path.join(dir, "notes"));
    const extension = readFileSync(path.join(dir, "index.ts"), "utf8");
    expect(extension).toContain("xaiProvider()");
    expect(extension).toContain("auth: { oauth:");
    await imports.remove("grok");
    expect(existsSync(path.join(dir, "notes"))).toBe(true);
  });
  it("drops an import the user rewrote in Pi and lists the remaining credential as a Pi login", async () => {
    const { home, authPath, imports } = setup();
    await imports.add("codex", credential);
    expect(await imports.list()).toHaveLength(1);
    expect((await imports.listOthers?.())?.some((l) => l.provider === "codex")).toBe(false);
    // The user edits auth.json by hand, dropping codexhost's ownership marker.
    const auth = JSON.parse(readFileSync(authPath, "utf8"));
    delete auth.codex.codexhostImportId;
    writeFileSync(authPath, JSON.stringify(auth));
    expect(await imports.list()).toEqual([]);
    expect(await imports.listOthers?.()).toEqual([
      { provider: "codex", type: "oauth" },
      { provider: "openai-codex", type: "api_key" },
    ]);
    // Deleting the credential outright leaves nothing to show anywhere.
    writeFileSync(authPath, JSON.stringify({}));
    expect(await imports.list()).toEqual([]);
    expect(await imports.listOthers?.()).toEqual([]);
    expect(existsSync(path.join(home, "extensions/codexhost-account-codex"))).toBe(true);
  });
  it("skips an import whose metadata is unreadable instead of failing the whole list", async () => {
    const { home, imports } = setup();
    await imports.add("codex", credential);
    writeFileSync(path.join(home, "extensions/codexhost-account-codex/import.json"), "not json");
    expect(await imports.list()).toEqual([]);
  });
  it("lists only the other logins, as Provider and type without any value", async () => {
    const { authPath, imports } = setup();
    expect(await imports.listOthers?.()).toEqual([{ provider: "openai-codex", type: "api_key" }]);
    await imports.add("codex", credential);
    const auth = JSON.parse(readFileSync(authPath, "utf8"));
    writeFileSync(
      authPath,
      JSON.stringify({
        ...auth,
        anthropic: { type: "oauth", access: "a-secret", refresh: "r-secret", expires: 1 },
        weird: "not-an-object",
      }),
    );
    const others = await imports.listOthers?.();
    expect(others).toEqual([
      { provider: "anthropic", type: "oauth" },
      { provider: "openai-codex", type: "api_key" },
      { provider: "weird", type: "unknown" },
    ]);
    expect(JSON.stringify(others)).not.toContain("secret");
    expect(JSON.stringify(others)).not.toContain("existing");
    expect(others?.some((entry) => entry.provider === "codex")).toBe(false);
  });
  it("names the OAuth vendor from the token issuer, whatever the Pi entry is called", async () => {
    const { authPath, imports } = setup();
    const token = (claims: object) =>
      `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig-secret`;
    const oauth = (claims: object) => ({
      type: "oauth",
      access: token(claims),
      refresh: "r-secret",
      expires: 1,
    });
    writeFileSync(
      authPath,
      JSON.stringify({
        "my-codex": oauth({
          iss: "https://auth.openai.com",
          client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
          "https://api.openai.com/profile": { email: "me@example.com" },
        }),
        "my-grok": oauth({
          iss: "https://auth.x.ai",
          client_id: "b1a00492-073a-47ea-816f-4c329264a828",
        }),
        // Same issuer, a different app: not a credential kind codexhost claims to recognize.
        other: oauth({ iss: "https://auth.openai.com", client_id: "app_other" }),
      }),
    );
    expect(await imports.listOthers?.()).toEqual([
      { provider: "my-codex", type: "oauth", label: "me@example.com", vendor: "openai-codex" },
      { provider: "my-grok", type: "oauth", vendor: "xai" },
      { provider: "other", type: "oauth" },
    ]);
  });
  it("derives an account label from a token email locally without returning the token", async () => {
    const { authPath, imports } = setup();
    const token = (claims: object) =>
      `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig-secret`;
    writeFileSync(
      authPath,
      JSON.stringify({
        codex1: {
          type: "oauth",
          access: token({ "https://api.openai.com/profile": { email: "same@example.com" } }),
          refresh: "r-secret",
          expires: 1,
        },
        plain: { type: "oauth", access: "not-a-jwt", refresh: "r", expires: 1 },
        key: { type: "api_key", key: "k-secret" },
      }),
    );
    const others = await imports.listOthers?.();
    expect(others).toEqual([
      { provider: "codex1", type: "oauth", label: "same@example.com" },
      { provider: "key", type: "api_key" },
      { provider: "plain", type: "oauth" },
    ]);
    expect(JSON.stringify(others)).not.toContain("secret");
  });
  it("also lists custom Providers whose key lives in models.json, merged by Provider name", async () => {
    const { home, authPath, imports } = setup();
    writeFileSync(authPath, JSON.stringify({ shared: { type: "api_key", key: "k-secret" } }));
    writeFileSync(
      path.join(home, "models.json"),
      JSON.stringify({
        providers: {
          "keyed-hub": { name: "Keyed Hub", baseUrl: "https://x", apiKey: "m-secret" },
          shared: { name: "shared", baseUrl: "https://y" },
          "no-key": { name: "No Key", baseUrl: "https://z" },
        },
      }),
    );
    const others = await imports.listOthers?.();
    expect(others).toEqual([
      { provider: "keyed-hub", type: "api_key", label: "Keyed Hub" },
      { provider: "shared", type: "api_key" },
    ]);
    expect(JSON.stringify(others)).not.toContain("secret");
  });
  it("removal touches only its own entry, leaving models.json and other logins intact", async () => {
    const { home, authPath, imports } = setup();
    const models = JSON.stringify({
      providers: { "linuxdo-hub": { name: "Hub", baseUrl: "https://x", apiKey: "m-secret" } },
    });
    const modelsPath = path.join(home, "models.json");
    writeFileSync(modelsPath, models);
    writeFileSync(
      authPath,
      JSON.stringify({
        "openai-codex": { type: "api_key", key: "existing" },
        deepseek: { type: "api_key", key: "keep-me" },
      }),
    );
    await imports.add("codex", credential);
    expect(Object.keys(JSON.parse(readFileSync(authPath, "utf8")))).toContain("codex");
    await imports.remove("codex");
    expect(JSON.parse(readFileSync(authPath, "utf8"))).toEqual({
      "openai-codex": { type: "api_key", key: "existing" },
      deepseek: { type: "api_key", key: "keep-me" },
    });
    expect(readFileSync(modelsPath, "utf8")).toBe(models);
    expect(existsSync(path.join(home, "extensions/codexhost-account-codex"))).toBe(false);
  });
  it("is not an import target when Pi has no configuration directory", async () => {
    const { home, imports } = setup();
    rmSync(home, { recursive: true, force: true });
    // The host drops a target whose listing throws, so the whole Pi surface disappears.
    await expect(imports.list()).rejects.toThrow();
  });
  it("returns no other logins when Pi has no auth store or models file", async () => {
    const { authPath, imports } = setup();
    rmSync(authPath);
    expect(await imports.listOthers?.()).toEqual([]);
  });
});
