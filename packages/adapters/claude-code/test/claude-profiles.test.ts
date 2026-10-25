import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { harnessIdSchema } from "@codexhost/shared-contracts";
import { ClaudeCodeAdapter, mergeSessionEnvironment } from "../src/claude-code-adapter.js";
import { createHarnessAdapter } from "../src/plugin.js";

describe("Claude Code profile adapter support", () => {
  let temporaryDir: string;

  beforeEach(async () => {
    temporaryDir = path.join(os.tmpdir(), `codexhost-claude-profile-test-${Date.now()}`);
    await mkdir(temporaryDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(temporaryDir, { recursive: true, force: true });
  });

  it("parameterizes harnessId on ClaudeCodeAdapter and Session", async () => {
    const adapter = new ClaudeCodeAdapter({
      harnessId: "claude-custom",
    });

    expect(adapter.harnessId).toBe("claude-custom");

    const sessionResult = await adapter.open({
      cwd: temporaryDir,
      kind: "resume",
      nativeRef: {
        harnessId: harnessIdSchema.parse("claude-custom"),
        nativeSessionId: "11111111-1111-4111-8111-111111111111",
        formatVersion: 1,
      },
      environment: {},
    });

    expect(sessionResult.ok).toBe(true);
    if (!sessionResult.ok) return;

    const session = sessionResult.value;
    expect(session.harnessId).toBe("claude-custom");
    expect(session.initialState.nativeRef?.harnessId).toBe("claude-custom");

    await session.close();
    await adapter.close();
  });

  it("loads profile configuration from CODEXHOST_CLAUDE_PROFILES_FILE in plugin", async () => {
    const profilesPath = path.join(temporaryDir, "claude-code-profiles.json");
    const customConfigDir = path.join(temporaryDir, "claude-custom");
    await mkdir(customConfigDir, { recursive: true });

    await writeFile(
      profilesPath,
      JSON.stringify([
        {
          id: "claude-custom",
          name: "Claude Custom",
          command: "/bin/sh",
          configDir: customConfigDir,
          environment: {
            CUSTOM_VAR: "custom_value",
          },
        },
      ]),
      "utf8",
    );

    const adapter = await createHarnessAdapter({
      environment: {
        CODEXHOST_CLAUDE_PROFILES_FILE: profilesPath,
      },
      harnessId: "claude-custom",
      platform: process.platform,
      managedRemoteHost: false,
    });

    expect(adapter.harnessId).toBe("claude-custom");
    await adapter.close();
  });

  it("fails when requested profile is not found in configuration", async () => {
    await expect(
      createHarnessAdapter({
        environment: {
          CODEXHOST_CLAUDE_PROFILES_FILE: path.join(temporaryDir, "nonexistent.json"),
        },
        harnessId: "missing-profile",
        platform: process.platform,
        managedRemoteHost: false,
      }),
    ).rejects.toThrow("unavailable");
  });

  it("does not leak profile environment variables into shared shell environment cache", async () => {
    const profilesPath = path.join(temporaryDir, "claude-code-profiles.json");
    const customConfigDir = path.join(temporaryDir, "claude-custom");
    await mkdir(customConfigDir, { recursive: true });

    await writeFile(
      profilesPath,
      JSON.stringify([
        {
          id: "claude-custom",
          name: "Claude Custom",
          command: "/bin/sh",
          configDir: customConfigDir,
          environment: {
            SECRET_PROFILE_ENV: "isolated_val",
          },
        },
      ]),
      "utf8",
    );

    // 1. Create custom profile adapter
    const customAdapter = await createHarnessAdapter({
      environment: {
        HOME: temporaryDir,
        SHELL: "/bin/zsh",
        CODEXHOST_CLAUDE_PROFILES_FILE: profilesPath,
      },
      harnessId: "claude-custom",
      platform: process.platform,
      managedRemoteHost: false,
    });
    await customAdapter.close();

    // 2. Create standard claude-code adapter sharing the same shell environment cache key
    const standardAdapter = await createHarnessAdapter({
      environment: {
        HOME: temporaryDir,
        SHELL: "/bin/zsh",
        CODEXHOST_CLAUDE_PROFILES_FILE: profilesPath,
      },
      harnessId: "claude-code",
      platform: process.platform,
      managedRemoteHost: false,
    });

    expect((customAdapter as ClaudeCodeAdapter).environment.SECRET_PROFILE_ENV).toBe(
      "isolated_val",
    );
    expect((customAdapter as ClaudeCodeAdapter).environment.CLAUDE_CONFIG_DIR).toBe(
      customConfigDir,
    );
    expect((standardAdapter as ClaudeCodeAdapter).environment.SECRET_PROFILE_ENV).toBeUndefined();
    expect((standardAdapter as ClaudeCodeAdapter).environment.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(process.env.SECRET_PROFILE_ENV).toBeUndefined();
    await standardAdapter.close();
  });

  it("strips ambient nested session variables from the effective environment", async () => {
    const profilesPath = path.join(temporaryDir, "claude-code-profiles.json");
    await writeFile(
      profilesPath,
      JSON.stringify([
        {
          id: "claude-custom",
          name: "Claude Custom",
          configDir: path.join(temporaryDir, ".claude-custom"),
        },
      ]),
      "utf8",
    );

    for (const harnessId of ["claude-code", "claude-custom"]) {
      const adapter = await createHarnessAdapter({
        environment: {
          HOME: temporaryDir,
          SHELL: "/bin/zsh",
          CODEXHOST_CLAUDE_PROFILES_FILE: profilesPath,
          CLAUDECODE: "1",
          CLAUDE_CODE_SESSION_ID: "outer-session",
          CLAUDE_CODE_ENTRYPOINT: "outer-entrypoint",
          CLAUDE_PID: "4242",
          CLAUDE_EFFORT: "high",
        },
        harnessId,
        platform: process.platform,
        managedRemoteHost: false,
      });
      const environment = (adapter as ClaudeCodeAdapter).environment;
      expect(environment.CLAUDECODE).toBeUndefined();
      expect(environment.CLAUDE_CODE_SESSION_ID).toBeUndefined();
      expect(environment.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
      expect(environment.CLAUDE_PID).toBeUndefined();
      expect(environment.CLAUDE_EFFORT).toBeUndefined();
      await adapter.close();
    }
  });

  it("keeps a Profile's declared routing over Host-supplied open overrides", () => {
    const merged = mergeSessionEnvironment({
      base: { PATH: "/usr/bin", ANTHROPIC_BASE_URL: "https://base.example.com" },
      override: {
        ANTHROPIC_BASE_URL: "https://host.example.com",
        ANTHROPIC_AUTH_TOKEN: "host-token",
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION_ID: "parent",
      },
      pinned: {
        ANTHROPIC_BASE_URL: "https://profile.example.com",
        ANTHROPIC_AUTH_TOKEN: "profile-token",
        CLAUDE_CONFIG_DIR: "/fake/profile-config",
      },
      configDirectory: "/fake/profile-config",
    });

    expect(merged.ANTHROPIC_BASE_URL).toBe("https://profile.example.com");
    expect(merged.ANTHROPIC_AUTH_TOKEN).toBe("profile-token");
    expect(merged.CLAUDE_CONFIG_DIR).toBe("/fake/profile-config");
    expect(merged.CLAUDECODE).toBeUndefined();
    expect(merged.CLAUDE_CODE_SESSION_ID).toBeUndefined();
  });

  it("keeps Host overrides for the default instance but never nested session variables", () => {
    const merged = mergeSessionEnvironment({
      base: { PATH: "/usr/bin" },
      override: { ANTHROPIC_MODEL: "host-model", CLAUDE_PID: "99" },
      pinned: {},
      configDirectory: undefined,
    });

    expect(merged.ANTHROPIC_MODEL).toBeUndefined();
    expect(merged.CLAUDE_PID).toBeUndefined();
  });

  it("keeps legitimate non-nested Host overrides for the default instance", () => {
    const merged = mergeSessionEnvironment({
      base: { PATH: "/usr/bin", ANTHROPIC_BASE_URL: "https://base.example.com" },
      override: { ANTHROPIC_BASE_URL: "https://custom.example.com" },
      pinned: {},
      configDirectory: undefined,
    });

    expect(merged.ANTHROPIC_BASE_URL).toBe("https://custom.example.com");
  });
});
