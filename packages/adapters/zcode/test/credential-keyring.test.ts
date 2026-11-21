import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { accountConfig } from "../src/account.js";
import { readSystemCredentialKey } from "../src/credential-keyring.js";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  return { execFile: Object.assign(() => {}, { [promisify.custom]: execute }) };
});
const account = "e".repeat(64);
const fixtureOutput = "synthetic backend output";

afterEach(() => {
  vi.unstubAllGlobals();
  execute.mockReset();
});

it.each(["darwin", "linux"])("handles only %s backend's own trailing newline", async (platform) => {
  vi.stubGlobal("process", { ...process, platform });
  if (platform === "darwin")
    execute.mockResolvedValueOnce({ stdout: '"/fixture/keychain"\n', stderr: "" });
  execute.mockResolvedValueOnce({ stdout: `${fixtureOutput}\n`, stderr: "" });
  expect(await readSystemCredentialKey(account)).toBe(
    platform === "linux" ? `${fixtureOutput}\n` : fixtureOutput,
  );
});

it.each(["timeout", "missing"])(
  "diagnoses a macOS Keychain %s without exposing process output",
  async (scenario) => {
    const root = await mkdtemp(path.join(tmpdir(), "zcode-keychain-test-"));
    try {
      const builtin = path.join(root, "builtin.json");
      await writeFile(
        builtin,
        JSON.stringify({ revision: 1, config: { providerConfigRules: { providerRules: [] } } }),
      );
      const payload =
        Buffer.alloc(12).toString("base64url") + "." + Buffer.alloc(16).toString("base64url") + ".";
      await writeFile(
        path.join(root, "credentials.json"),
        JSON.stringify({
          "oauth:active_provider": `enc:v2:os:${"0".repeat(24)}:${payload}`,
        }),
      );
      vi.stubGlobal("process", { ...process, platform: "darwin" });
      execute.mockResolvedValueOnce({ stdout: '"/fixture/keychain"\n', stderr: "" });
      execute.mockRejectedValueOnce(
        Object.assign(new Error(fixtureOutput), {
          code: scenario === "timeout" ? null : 44,
          killed: scenario === "timeout",
          signal: scenario === "timeout" ? "SIGTERM" : null,
          stdout: fixtureOutput,
          stderr: fixtureOutput,
        }),
      );
      const config = await accountConfig(
        {
          dataRoot: root,
          version: "3.18.2",
          runtime: "",
          cli: "",
          builtinProviderConfig: builtin,
          personalProviderConfig: "",
        },
        {},
      );
      expect(config.credentialIssue).not.toContain(fixtureOutput);
      if (scenario === "timeout") {
        expect(config.credentialIssue).toMatch(
          /Keychain read timed out.*allow access to ZCode Credential Encryption/i,
        );
        expect(config.credentialIssue).not.toContain("does not match");
        expect(execute.mock.lastCall?.[2]).toMatchObject({ timeout: 30_000 });
      } else {
        expect(config.credentialIssue).toMatch(/original key is unavailable or does not match/i);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
