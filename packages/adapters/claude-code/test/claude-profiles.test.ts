import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { harnessIdSchema } from "@codexhost/shared-contracts";
import { ClaudeCodeAdapter } from "../src/claude-code-adapter.js";
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
        SHELL: "/bin/sh",
        CODEXHOST_CLAUDE_PROFILES_FILE: profilesPath,
      },
      harnessId: "claude-custom",
      platform: process.platform,
      managedRemoteHost: false,
    });
    await customAdapter.close();

    // 2. Create standard claude-code adapter
    const standardAdapter = await createHarnessAdapter({
      environment: {
        HOME: temporaryDir,
        SHELL: "/bin/sh",
        CODEXHOST_CLAUDE_PROFILES_FILE: profilesPath,
      },
      harnessId: "claude-code",
      platform: process.platform,
      managedRemoteHost: false,
    });

    expect(process.env.SECRET_PROFILE_ENV).toBeUndefined();
    await standardAdapter.close();
  });
});
