import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  HARNESS_USER_INSTRUCTIONS_SETTINGS_GET_METHOD,
  HARNESS_USER_INSTRUCTIONS_SETTINGS_SET_METHOD,
  harnessPluginIdSchema,
} from "@codexhost/shared-contracts";
import { HarnessUserInstructionsStore } from "../src/harness-user-instructions.js";
import { createFixture, requestId, stopFixture, writeRequest } from "./app-server-host-fixture.js";

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("HarnessUserInstructionsStore", () => {
  it("backs up existing CLI user instructions, syncs Codex instructions, and restores originals when disabled", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "user-instructions-home-"));
    const dataDir = path.join(home, ".codexhost");
    try {
      await mkdir(path.join(home, ".codex"), { recursive: true });
      await writeFile(path.join(home, ".codex", "AGENTS.md"), "# Codex Global Instructions\n");

      await mkdir(path.join(home, ".claude"), { recursive: true });
      await writeFile(path.join(home, ".claude", "CLAUDE.md"), "# Original Claude Rules\n");

      await mkdir(path.join(home, ".gemini"), { recursive: true });

      const store = new HarnessUserInstructionsStore({
        HOME: home,
        USERPROFILE: home,
        CODEXHOST_DATA_DIR: dataDir,
      });

      const initial = await store.get();
      expect(initial.enabled).toBe(false);
      expect(initial.sourcePath).toBe("~/.codex/AGENTS.md");
      expect(initial.harnesses.every((entry) => entry.enabled)).toBe(true);

      // Enabling globally replaces ~/.claude/CLAUDE.md and creates ~/.gemini/GEMINI.md,
      // while leaving uninstalled CLI folders (like ~/.devin) untouched.
      const enabled = await store.set({ enabled: true });
      expect(enabled.enabled).toBe(true);
      expect(await readFile(path.join(home, ".claude", "CLAUDE.md"), "utf8")).toBe(
        "# Codex Global Instructions\n",
      );
      expect(await readFile(path.join(home, ".gemini", "GEMINI.md"), "utf8")).toBe(
        "# Codex Global Instructions\n",
      );
      expect(await fileExists(path.join(home, ".devin"))).toBe(false);

      // Disabling a single CLI (claude-code) restores its original file while keeping antigravity synced.
      const claudeDisabled = await store.set({
        enabled: true,
        disabledHarnesses: [harnessPluginIdSchema.parse("claude-code")],
      });
      expect(
        claudeDisabled.harnesses.find((entry) => entry.harnessId === "claude-code")?.enabled,
      ).toBe(false);
      expect(await readFile(path.join(home, ".claude", "CLAUDE.md"), "utf8")).toBe(
        "# Original Claude Rules\n",
      );
      expect(await readFile(path.join(home, ".gemini", "GEMINI.md"), "utf8")).toBe(
        "# Codex Global Instructions\n",
      );

      // Disabling globally removes ~/.gemini/GEMINI.md (which had no original file).
      await store.set({
        enabled: false,
        disabledHarnesses: [harnessPluginIdSchema.parse("claude-code")],
      });
      expect(await fileExists(path.join(home, ".gemini", "GEMINI.md"))).toBe(false);
      expect(await readFile(path.join(home, ".claude", "CLAUDE.md"), "utf8")).toBe(
        "# Original Claude Rules\n",
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("prefers AGENTS.override.md over AGENTS.md and creates config directory on syncHarness", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "user-instructions-override-"));
    try {
      await mkdir(path.join(home, ".codex"), { recursive: true });
      await writeFile(path.join(home, ".codex", "AGENTS.md"), "# Base Codex\n");
      await writeFile(path.join(home, ".codex", "AGENTS.override.md"), "# Override Codex\n");

      const store = new HarnessUserInstructionsStore({
        HOME: home,
        USERPROFILE: home,
        CODEXHOST_DATA_DIR: path.join(home, ".codexhost"),
      });

      const settings = await store.set({ enabled: true });
      expect(settings.sourcePath).toBe("~/.codex/AGENTS.override.md");

      // kiro-cli directory does not exist yet; syncHarness creates ~/.kiro/steering/AGENTS.md on session open.
      await store.syncHarness(harnessPluginIdSchema.parse("kiro-cli"));
      expect(await readFile(path.join(home, ".kiro", "steering", "AGENTS.md"), "utf8")).toBe(
        "# Override Codex\n",
      );

      await store.set({ enabled: false });
      expect(await fileExists(path.join(home, ".kiro", "steering", "AGENTS.md"))).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("routes Desktop and Console user instructions settings RPCs and validates input", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "user-instructions-rpc-"));
    const env = {
      HOME: home,
      USERPROFILE: home,
      CODEXHOST_DATA_DIR: path.join(home, ".codexhost"),
    };
    const desktop = createFixture({ environment: env });
    const consoleHost = createFixture({ environment: env });
    try {
      await mkdir(path.join(home, ".codex"), { recursive: true });
      await writeFile(path.join(home, ".codex", "AGENTS.md"), "# Shared Instructions\n");
      await mkdir(path.join(home, ".gemini"), { recursive: true });

      const setReply = await consoleHost.host.handleConsoleRequest(
        HARNESS_USER_INSTRUCTIONS_SETTINGS_SET_METHOD,
        {
          enabled: true,
          disabledHarnesses: ["qwen-code"],
        },
      );
      expect(setReply).toMatchObject({
        result: {
          enabled: true,
          sourcePath: "~/.codex/AGENTS.md",
        },
      });
      expect(await readFile(path.join(home, ".gemini", "GEMINI.md"), "utf8")).toBe(
        "# Shared Instructions\n",
      );

      writeRequest(desktop.desktopInput, {
        id: 801,
        method: HARNESS_USER_INSTRUCTIONS_SETTINGS_GET_METHOD,
        params: {},
      });
      const getReply = await desktop.collector.waitFor((message) => requestId(message, 801));
      expect(getReply).toMatchObject({
        result: {
          enabled: true,
          sourcePath: "~/.codex/AGENTS.md",
        },
      });

      expect(
        await consoleHost.host.handleConsoleRequest(HARNESS_USER_INSTRUCTIONS_SETTINGS_SET_METHOD, {
          enabled: "invalid",
        }),
      ).toMatchObject({ error: { code: -32602 } });

      expect(
        await consoleHost.host.handleConsoleRequest(HARNESS_USER_INSTRUCTIONS_SETTINGS_GET_METHOD, {
          extra: true,
        }),
      ).toMatchObject({ error: { code: -32602 } });
    } finally {
      await stopFixture(desktop);
      await stopFixture(consoleHost);
      await rm(home, { recursive: true, force: true });
    }
  });
});
