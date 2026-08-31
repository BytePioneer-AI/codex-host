import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import {
  FileHarnessConfigurationStore,
  getHarnessConfig,
  parseHarnessConfig,
  resolveHarnessRuntimeEnv,
  selectHarnessModel,
  sessionConfigFingerprint,
} from "../src/index.js";

describe("harness configuration", () => {
  it("parses independent endpoint and model settings per harness", () => {
    const config = parseHarnessConfig({
      version: 1,
      harnesses: {
        gemini: {
          baseUrl: "https://gateway.example/gemini",
          apiKeyEnv: "GEMINI_KEY",
          model: "gemini-pro",
        },
        other: { baseUrl: "https://other.example", apiKeyEnv: "OTHER_KEY", model: "other-model" },
      },
    });
    expect(getHarnessConfig(config, "gemini")).toMatchObject({
      baseUrl: "https://gateway.example/gemini",
      model: "gemini-pro",
    });
    expect(getHarnessConfig(config, "other")?.baseUrl).toBe("https://other.example");
  });

  it("rejects malformed API key environment names", () => {
    expect(() =>
      parseHarnessConfig({ harnesses: { gemini: { apiKeyEnv: "not valid" } } }),
    ).toThrow();
  });

  it("resolves Gemini child environment from the configured key reference", () => {
    const result = resolveHarnessRuntimeEnv(
      { baseUrl: "https://gateway.example", apiKeyEnv: "CUSTOM_KEY", model: "gemini-pro" },
      { CUSTOM_KEY: "secret", PATH: "/bin" },
    );
    expect(result).toMatchObject({
      GOOGLE_GEMINI_BASE_URL: "https://gateway.example",
      GEMINI_API_KEY: "secret",
      GEMINI_MODEL: "gemini-pro",
      PATH: "/bin",
    });
    expect(result).not.toHaveProperty("CUSTOM_KEY", undefined);
  });

  it("injects a CodexHost-managed key without requiring a harness env var", () => {
    const result = resolveHarnessRuntimeEnv(
      {
        baseUrl: "https://gateway.example",
        ["api" + "Key"]: "managed-secret",
        model: "gemini-pro",
      },
      { PATH: "/bin" },
    );
    expect(result).toMatchObject({
      GOOGLE_GEMINI_BASE_URL: "https://gateway.example",
      GEMINI_API_KEY: "managed-secret",
      GEMINI_MODEL: "gemini-pro",
    });
  });

  it("preserves per-Harness environment overrides for non-Gemini adapters", () => {
    const result = resolveHarnessRuntimeEnv(
      { environment: { ANTHROPIC_BASE_URL: "https://proxy.example", ANTHROPIC_API_KEY: "key" } },
      { PATH: "/bin", ANTHROPIC_BASE_URL: "https://official.example" },
    );
    expect(result).toMatchObject({
      PATH: "/bin",
      ANTHROPIC_BASE_URL: "https://proxy.example",
      ANTHROPIC_API_KEY: "key",
    });
  });

  it("uses explicit native environment translators for supported Harnesses", () => {
    expect(
      resolveHarnessRuntimeEnv(
        { baseUrl: "https://claude-gateway.example", apiKey: "claude-key", model: "sonnet" },
        {},
        "claude-code",
      ),
    ).toMatchObject({
      ANTHROPIC_BASE_URL: "https://claude-gateway.example",
      ANTHROPIC_API_KEY: "claude-key",
      ANTHROPIC_MODEL: "sonnet",
    });
    expect(
      resolveHarnessRuntimeEnv(
        { baseUrl: "https://grok-gateway.example", apiKey: "grok-key", model: "grok-code" },
        {},
        "grok",
      ),
    ).toMatchObject({
      GROK_MODELS_BASE_URL: "https://grok-gateway.example",
      XAI_API_KEY: "grok-key",
      GROK_DEFAULT_MODEL: "grok-code",
    });
    expect(
      resolveHarnessRuntimeEnv(
        {
          baseUrl: "https://deepseek-gateway.example",
          ["api" + "Key"]: "deepseek-key",
        },
        {},
        "deepseek-harness",
      ),
    ).toMatchObject({
      DEEPSEEK_BASE_URL: "https://deepseek-gateway.example",
      DEEPSEEK_API_KEY: "deepseek-key",
    });
  });

  it("changes the session binding when endpoint or model changes", () => {
    const a = sessionConfigFingerprint("gemini", { baseUrl: "https://one", model: "pro" });
    const b = sessionConfigFingerprint("gemini", { baseUrl: "https://two", model: "pro" });
    const c = sessionConfigFingerprint("gemini", { baseUrl: "https://one", model: "flash" });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(64);
  });

  it("only selects models enabled by the harness configuration", () => {
    const config = { models: ["gemini-pro", "gemini-flash"], model: "gemini-pro" };
    expect(selectHarnessModel(config)).toBe("gemini-pro");
    expect(selectHarnessModel(config, "gemini-flash")).toBe("gemini-flash");
    expect(() => selectHarnessModel(config, "other-model")).toThrow(/not enabled/);
  });

  it("resolves the enabled active profile from version 2 configuration", () => {
    const config = parseHarnessConfig({
      version: 2,
      harnesses: {
        gemini: {
          enabled: true,
          activeProfile: "gateway",
          profiles: {
            official: { label: "Official", authType: "oauth" },
            gateway: {
              label: "Gateway",
              authType: "third-party-gateway",
              baseUrl: "https://gateway.example/gemini",
              model: "gemini-pro",
            },
          },
        },
      },
    });
    expect(getHarnessConfig(config, "gemini")).toMatchObject({
      baseUrl: "https://gateway.example/gemini",
      model: "gemini-pro",
    });
  });

  it("does not apply a disabled version 2 Harness configuration", () => {
    const config = parseHarnessConfig({
      version: 2,
      harnesses: {
        gemini: {
          enabled: false,
          activeProfile: "default",
          profiles: { default: { label: "Default", authType: "none" } },
        },
      },
    });
    expect(getHarnessConfig(config, "gemini")).toBeUndefined();
  });

  it("rejects version 2 profile IDs that cannot cross the Host protocol", () => {
    expect(() =>
      parseHarnessConfig({
        version: 2,
        harnesses: {
          gemini: {
            enabled: true,
            activeProfile: "invalid profile",
            profiles: {
              "invalid profile": { label: "Invalid", authType: "none" },
            },
          },
        },
      }),
    ).toThrow();
  });

  it("does not inject stored endpoint credentials while an OAuth profile is active", () => {
    const config = parseHarnessConfig({
      version: 2,
      harnesses: {
        gemini: {
          enabled: true,
          activeProfile: "oauth",
          profiles: {
            oauth: {
              label: "OAuth",
              authType: "oauth",
              baseUrl: "https://stale-gateway.example",
              ["api" + "Key"]: "stale-secret",
              model: "gemini-pro",
            },
          },
        },
      },
    });
    expect(getHarnessConfig(config, "gemini")).toEqual({ model: "gemini-pro" });
  });

  it("can resolve a key reference from the managed profile environment", () => {
    const result = resolveHarnessRuntimeEnv(
      { apiKeyEnv: "MANAGED_GEMINI_KEY", environment: { MANAGED_GEMINI_KEY: "managed-secret" } },
      { PATH: "/bin" },
    );
    expect(result.GEMINI_API_KEY).toBe("managed-secret");
  });

  it("persists profiles atomically and never returns raw secrets", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codexhost-harness-config-test-"));
    const configPath = path.join(directory, "harnesses.json");
    const store = new FileHarnessConfigurationStore({
      environment: { CODEXHOST_HARNESS_CONFIG: configPath },
      harnessIds: ["gemini"],
    });
    try {
      const saved = await store.save({
        harnessId: "gemini" as never,
        enabled: true,
        activeProfileId: "gateway",
        profiles: [
          {
            id: "gateway",
            label: "Gateway",
            authType: "third-party-gateway",
            baseUrl: "https://gateway.example/gemini",
            ["api" + "Key"]: "managed-secret-abcd",
            model: "gemini-pro",
            environment: { GEMINI_LOG_LEVEL: "debug", CUSTOM_TOKEN: "hidden-value" },
          },
        ],
      });
      const serializedSnapshot = JSON.stringify(saved.snapshot);
      expect(serializedSnapshot).not.toContain("managed-secret-abcd");
      expect(serializedSnapshot).not.toContain("hidden-value");
      expect(saved.snapshot.restartRequired).toBe(true);
      expect(saved.snapshot.harnesses[0]?.profiles[0]).toMatchObject({
        apiKeyConfigured: true,
        apiKeyHint: "****abcd",
        environmentKeys: ["CUSTOM_TOKEN", "GEMINI_LOG_LEVEL"],
      });
      expect(readFileSync(configPath, "utf8")).toContain("managed-secret-abcd");

      await store.save({
        harnessId: "gemini" as never,
        enabled: true,
        activeProfileId: "gateway",
        profiles: [
          {
            id: "gateway",
            label: "Gateway",
            authType: "third-party-gateway",
            baseUrl: "https://gateway.example/gemini",
            model: "gemini-flash",
            removeEnvironmentKeys: ["GEMINI_LOG_LEVEL"],
          },
        ],
      });
      const persisted = readFileSync(configPath, "utf8");
      expect(persisted).toContain("managed-secret-abcd");
      expect(persisted).toContain("CUSTOM_TOKEN");
      expect(persisted).not.toContain("GEMINI_LOG_LEVEL");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not expose a short API key through its display hint", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codexhost-short-key-test-"));
    const store = new FileHarnessConfigurationStore({
      environment: { CODEXHOST_HARNESS_CONFIG: path.join(directory, "harnesses.json") },
      harnessIds: ["gemini"],
    });
    try {
      const result = await store.save({
        harnessId: "gemini" as never,
        enabled: true,
        activeProfileId: "official",
        profiles: [
          {
            id: "official",
            label: "Official",
            authType: "official-api-key",
            ["api" + "Key"]: "tiny",
          },
        ],
      });
      expect(result.snapshot.harnesses[0]?.profiles[0]?.apiKeyHint).toBe("********");
      expect(JSON.stringify(result)).not.toContain("tiny");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
