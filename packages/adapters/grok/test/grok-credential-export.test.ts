import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { readGrokCredentials } from "../src/grok-credential-export.js";
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true })));
});
it("exports only the native xAI OAuth client, respecting explicit API credentials", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "grok-export-"));
  homes.push(home);
  const client = "b1a00492-073a-47ea-816f-4c329264a828";
  const value = {
    key: "secret-access",
    refresh_token: "secret-refresh",
    user_id: "user-a",
    email: "a@example.com",
    expires_at: "2030-01-01T00:00:00Z",
    oidc_issuer: "https://auth.x.ai",
    oidc_client_id: client,
  };
  const save = async (entry: object) =>
    writeFile(
      path.join(home, "auth.json"),
      JSON.stringify({ [`https://auth.x.ai::${client}`]: entry }),
    );
  await save(value);
  const result = await readGrokCredentials({ GROK_HOME: home });
  expect(result[0]?.oauth).toEqual({
    access: "secret-access",
    refresh: "secret-refresh",
    expires: Date.parse(value.expires_at) - 300000,
  });
  expect(result[0]?.source.label).toBe("a@example.com");
  expect(await readGrokCredentials({ GROK_HOME: home, XAI_API_KEY: "override" })).toEqual([]);
  await save({ ...value, oidc_issuer: "https://untrusted.invalid" });
  expect(await readGrokCredentials({ GROK_HOME: home })).toEqual([]);
  await save({ ...value, expires_at: "invalid" });
  expect(await readGrokCredentials({ GROK_HOME: home })).toEqual([]);
});
