import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { accountConfig } from "../src/account.js";
import {
  KeychainAccessDeferred,
  KeychainReadTimeout,
  readSystemCredentialKey,
  resetSystemCredentialKeyCache,
} from "../src/credential-keyring.js";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  return { execFile: Object.assign(() => {}, { [promisify.custom]: execute }) };
});
const account = "e".repeat(64);
const fixtureOutput = "synthetic backend output";

afterEach(() => {
  resetSystemCredentialKeyCache();
  vi.unstubAllGlobals();
  execute.mockReset();
});

it.each(["darwin", "linux"])("handles only %s backend's own trailing newline", async (platform) => {
  vi.stubGlobal("process", { ...process, platform });
  if (platform === "darwin")
    execute.mockResolvedValueOnce({ stdout: '"/fixture/keychain"\n', stderr: "" });
  execute.mockResolvedValueOnce({ stdout: `${fixtureOutput}\n`, stderr: "" });
  expect(
    await readSystemCredentialKey(account, platform === "darwin" ? { access: "allow" } : undefined),
  ).toBe(platform === "linux" ? `${fixtureOutput}\n` : fixtureOutput);
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
        { access: "allow" },
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

it("deduplicates concurrent macOS Keychain reads and caches the resolved key in process", async () => {
  vi.stubGlobal("process", { ...process, platform: "darwin" });
  execute.mockResolvedValueOnce({ stdout: '"/fixture/keychain"\n', stderr: "" });
  execute.mockResolvedValueOnce({ stdout: `${fixtureOutput}\n`, stderr: "" });
  await expect(readSystemCredentialKey(account)).rejects.toBeInstanceOf(KeychainAccessDeferred);
  expect(execute).not.toHaveBeenCalled();
  const [first, second] = await Promise.all([
    readSystemCredentialKey(account, { access: "allow" }),
    readSystemCredentialKey(account, { access: "allow" }),
  ]);
  expect(first).toBe(fixtureOutput);
  expect(second).toBe(fixtureOutput);
  expect(execute).toHaveBeenCalledTimes(2);

  // Subsequent reads reuse the in-process cache without spawning /usr/bin/security again.
  expect(await readSystemCredentialKey(account)).toBe(fixtureOutput);
  expect(execute).toHaveBeenCalledTimes(2);
});

it("shares a stalled macOS Keychain read across passive and explicit callers", async () => {
  vi.stubGlobal("process", { ...process, platform: "darwin" });
  const started = Promise.withResolvers<undefined>();
  const read = Promise.withResolvers<{ stdout: string }>();
  execute.mockResolvedValueOnce({ stdout: '"/fixture/keychain"\n' });
  execute.mockImplementationOnce(() => {
    started.resolve(undefined);
    return read.promise;
  });
  const earlierGesture = performance.now();
  const passive = readSystemCredentialKey(account, { access: "allow" });
  await started.promise;
  const active = readSystemCredentialKey(account, { access: "retry" });
  const completed = Promise.allSettled([passive, active]);
  read.reject(
    Object.assign(new Error("synthetic timeout"), { killed: true, code: null, signal: "SIGTERM" }),
  );
  expect(await completed).toEqual([
    { status: "rejected", reason: expect.any(KeychainReadTimeout) },
    { status: "rejected", reason: expect.any(KeychainReadTimeout) },
  ]);
  // Another workspace can reach the same account after the first lookup settled.
  await expect(
    readSystemCredentialKey(account, { access: "retry", requestedAt: earlierGesture }),
  ).rejects.toBeInstanceOf(KeychainReadTimeout);
  expect(execute.mock.calls.map(([, args]) => args[0])).toEqual([
    "default-keychain",
    "find-generic-password",
  ]);
});

it.each(["denied", "timeout"] as const)(
  "suppresses repeated macOS Keychain prompts after %s until an explicit retry",
  async (scenario) => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    execute.mockResolvedValueOnce({ stdout: '"/fixture/keychain"\n', stderr: "" });
    execute.mockRejectedValueOnce(
      Object.assign(new Error("user denied"), {
        code: scenario === "timeout" ? null : 128,
        killed: scenario === "timeout",
        signal: scenario === "timeout" ? "SIGTERM" : null,
      }),
    );
    if (scenario === "timeout") {
      await expect(readSystemCredentialKey(account, { access: "allow" })).rejects.toBeInstanceOf(
        KeychainReadTimeout,
      );
      // Repeated background reads return the cached timeout without spawning /usr/bin/security.
      await expect(readSystemCredentialKey(account)).rejects.toBeInstanceOf(KeychainReadTimeout);
    } else {
      expect(await readSystemCredentialKey(account, { access: "allow" })).toBeUndefined();
      expect(await readSystemCredentialKey(account)).toBeUndefined();
    }
    expect(execute).toHaveBeenCalledTimes(2);

    // An explicit retry clears the negative cache and caches the key once allowed.
    execute.mockResolvedValueOnce({ stdout: '"/fixture/keychain"\n', stderr: "" });
    execute.mockResolvedValueOnce({ stdout: `${fixtureOutput}\n`, stderr: "" });
    expect(await readSystemCredentialKey(account, { access: "retry" })).toBe(fixtureOutput);
    expect(execute).toHaveBeenCalledTimes(4);
    expect(await readSystemCredentialKey(account)).toBe(fixtureOutput);
    expect(execute).toHaveBeenCalledTimes(4);
  },
);
