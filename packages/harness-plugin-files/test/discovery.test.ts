import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverHarnessPlugins } from "../src/index.js";

describe("discoverHarnessPlugins", () => {
  let temporaryRoot: string;

  beforeEach(async () => {
    temporaryRoot = path.join(os.tmpdir(), `codexhost-discovery-test-${Date.now()}`);
    await mkdir(temporaryRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("discovers profiles when claude-code plugin is enabled", async () => {
    // 1. Create a root with enabled.json and claude-code plugin
    const pluginsRoot = path.join(temporaryRoot, "plugins");
    const claudeDir = path.join(pluginsRoot, "claude-code");
    await mkdir(claudeDir, { recursive: true });

    await writeFile(
      path.join(pluginsRoot, "enabled.json"),
      JSON.stringify({ version: 1, enabled: ["claude-code"] }),
      "utf8",
    );

    const baseManifest = {
      manifestVersion: 1,
      id: "claude-code",
      name: "Claude Code",
      version: "1.0.0",
      adapterApiVersion: 1,
      entry: "./plugin.mjs",
      links: { website: "https://code.claude.com/" },
    };
    await writeFile(path.join(claudeDir, "manifest.json"), JSON.stringify(baseManifest), "utf8");
    await writeFile(path.join(claudeDir, "plugin.mjs"), "export {}", "utf8");

    // 2. Create claude-code-profiles.json
    const profilesPath = path.join(temporaryRoot, "claude-code-profiles.json");
    await writeFile(
      profilesPath,
      JSON.stringify([
        {
          id: "claude-custom",
          name: "Claude Custom",
          description: "Claude Code Custom Profile",
        },
      ]),
      "utf8",
    );

    const result = await discoverHarnessPlugins([pluginsRoot], () => undefined, {
      CODEXHOST_CLAUDE_PROFILES_FILE: profilesPath,
    });

    expect(result.plugins).toHaveLength(2);
    const customPlugin = result.plugins.find((p) => p.manifest.id === "claude-custom");
    expect(customPlugin).toBeDefined();
    expect(customPlugin?.manifest.name).toBe("Claude Custom");
    expect(customPlugin?.manifest.entry).toBe("./plugin.mjs");
    expect(customPlugin?.enabled).toBe(true);
    expect(result.enabledIds.has("claude-custom")).toBe(true);
  });
});
