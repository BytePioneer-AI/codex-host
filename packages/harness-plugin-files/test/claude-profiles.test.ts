import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CLAUDE_CODE_PROFILES_FILE_ENV,
  defaultClaudeCodeProfilesPath,
  readClaudeCodeProfiles,
  readProfileIcon,
} from "../src/index.js";

describe("claude-profiles", () => {
  let temporaryDirectory: string;

  beforeEach(async () => {
    temporaryDirectory = path.join(os.tmpdir(), `codexhost-profiles-test-${Date.now()}`);
    await mkdir(temporaryDirectory, { recursive: true });
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("returns empty list if profiles file is missing", async () => {
    const missingPath = path.join(temporaryDirectory, "missing.json");
    const profiles = await readClaudeCodeProfiles(missingPath);
    expect(profiles).toEqual([]);
  });

  it("reads and parses valid profiles with path expansion", async () => {
    const profilesPath = path.join(temporaryDirectory, "claude-code-profiles.json");
    const testSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>`;
    const iconPath = path.join(temporaryDirectory, "icon.svg");
    await writeFile(iconPath, testSvg, "utf8");

    const content = [
      {
        id: "claude-custom",
        name: "Claude Custom",
        command: "~/bin/claude-custom",
        configDir: "~/.claude-custom",
        icon: "./icon.svg",
      },
    ];
    await writeFile(profilesPath, JSON.stringify(content), "utf8");

    const profiles = await readClaudeCodeProfiles(profilesPath, {
      HOME: "/custom/home",
    });

    expect(profiles).toHaveLength(1);
    const first = profiles[0];
    if (!first) throw new Error("Expected first profile");
    expect(first.id).toBe("claude-custom");
    expect(first.name).toBe("Claude Custom");
    expect(first.command).toBe(path.join("/custom/home", "bin/claude-custom"));
    expect(first.configDir).toBe(path.join("/custom/home", ".claude-custom"));
    expect(first.icon).toBe(iconPath);

    // Test readProfileIcon
    const profileIcon = first.icon;
    expect(profileIcon).toBeDefined();
    if (!profileIcon) throw new Error("Icon expected");
    const dataUrl = await readProfileIcon(profileIcon);
    expect(dataUrl.startsWith("data:image/svg+xml;base64,")).toBe(true);
  });

  it("resolves default path from environment variable", () => {
    const custom = path.resolve(temporaryDirectory, "custom-profiles.json");
    expect(
      defaultClaudeCodeProfilesPath({
        [CLAUDE_CODE_PROFILES_FILE_ENV]: custom,
      }),
    ).toBe(custom);
  });

  it("validates data url icon and rejects malformed data urls", async () => {
    const validDataUrl =
      "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjwvc3ZnPg==";
    expect(await readProfileIcon(validDataUrl)).toBe(validDataUrl);

    await expect(readProfileIcon("data:text/html;base64,PHNjcmlwdD4=")).rejects.toThrow();
    await expect(readProfileIcon("data:image/svg+xml,<svg></svg>")).rejects.toThrow();
  });

  it("drops profiles that share a resolved configDir", async () => {
    const profilesPath = path.join(temporaryDirectory, "shared-config.json");
    await writeFile(
      profilesPath,
      JSON.stringify([
        { id: "claude-one", name: "One", configDir: "./shared" },
        { id: "claude-two", name: "Two", configDir: "./shared" },
        { id: "claude-three", name: "Three", configDir: "./other" },
      ]),
      "utf8",
    );

    const profiles = await readClaudeCodeProfiles(profilesPath, { HOME: "/custom/home" });

    expect(profiles.map(({ id }) => id)).toEqual(["claude-one", "claude-three"]);
    expect(profiles[0]?.configDir).toBe(path.join(temporaryDirectory, "shared"));
  });

  it("drops profiles that alias one store through a symlink", async () => {
    const profilesPath = path.join(temporaryDirectory, "symlink-config.json");
    const realStore = path.join(temporaryDirectory, "real-store");
    const aliasStore = path.join(temporaryDirectory, "alias-store");
    await mkdir(realStore, { recursive: true });
    await symlink(realStore, aliasStore, "dir");
    await writeFile(
      profilesPath,
      JSON.stringify([
        { id: "claude-one", name: "One", configDir: realStore },
        { id: "claude-two", name: "Two", configDir: aliasStore },
        { id: "claude-three", name: "Three", configDir: "./other" },
      ]),
      "utf8",
    );

    const profiles = await readClaudeCodeProfiles(profilesPath, { HOME: "/custom/home" });

    expect(profiles.map(({ id }) => id)).toEqual(["claude-one", "claude-three"]);
  });

  it("drops profiles that alias one store through a symlinked parent directory that does not exist yet", async () => {
    const parentReal = path.join(temporaryDirectory, "parent-real");
    const parentSymlink = path.join(temporaryDirectory, "parent-symlink");
    await mkdir(parentReal, { recursive: true });
    await symlink(parentReal, parentSymlink, "dir");
    const profilesPath = path.join(temporaryDirectory, "symlink-parent-config.json");
    await writeFile(
      profilesPath,
      JSON.stringify([
        { id: "claude-one", name: "One", configDir: path.join(parentReal, "not-yet-created") },
        { id: "claude-two", name: "Two", configDir: path.join(parentSymlink, "not-yet-created") },
        { id: "claude-three", name: "Three", configDir: path.join(parentReal, "different-dir") },
      ]),
      "utf8",
    );

    const profiles = await readClaudeCodeProfiles(profilesPath, { HOME: "/custom/home" });

    expect(profiles.map(({ id }) => id)).toEqual(["claude-one", "claude-three"]);
  });

  it("refuses a profile that points at the default ~/.claude store", async () => {
    const home = path.join(temporaryDirectory, "home");
    await mkdir(path.join(home, ".claude"), { recursive: true });
    const profilesPath = path.join(temporaryDirectory, "default-config.json");
    await writeFile(
      profilesPath,
      JSON.stringify([
        { id: "claude-default", name: "Default", configDir: path.join(home, ".claude") },
        { id: "claude-own", name: "Own", configDir: path.join(home, ".claude-own") },
      ]),
      "utf8",
    );

    const profiles = await readClaudeCodeProfiles(profilesPath, { HOME: home });

    expect(profiles.map(({ id }) => id)).toEqual(["claude-own"]);
  });

  it("refuses a profile that points at the default instance custom CLAUDE_CONFIG_DIR", async () => {
    const customDefault = path.join(temporaryDirectory, "custom-default-claude");
    const profilesPath = path.join(temporaryDirectory, "custom-default-config.json");
    await writeFile(
      profilesPath,
      JSON.stringify([
        { id: "claude-default", name: "Matches custom default", configDir: customDefault },
        { id: "claude-other", name: "Other", configDir: path.join(temporaryDirectory, "other") },
      ]),
      "utf8",
    );

    const profiles = await readClaudeCodeProfiles(profilesPath, {
      HOME: "/custom/home",
      CLAUDE_CONFIG_DIR: customDefault,
    });

    expect(profiles.map(({ id }) => id)).toEqual(["claude-other"]);
  });

  it("refuses a profile pointing at default CLAUDE_CONFIG_DIR even when written as relative path", async () => {
    const relDefault = "./relative-custom-default";
    const absDefault = path.resolve(relDefault);
    const profilesPath = path.join(temporaryDirectory, "rel-config.json");
    await writeFile(
      profilesPath,
      JSON.stringify([
        { id: "claude-default", name: "Matches cwd default", configDir: absDefault },
        { id: "claude-other", name: "Other", configDir: path.join(temporaryDirectory, "other") },
      ]),
      "utf8",
    );

    const profiles = await readClaudeCodeProfiles(profilesPath, {
      HOME: "/custom/home",
      CLAUDE_CONFIG_DIR: relDefault,
    });

    expect(profiles.map(({ id }) => id)).toEqual(["claude-other"]);
  });

  it("skips malformed entries without hiding valid profiles", async () => {
    const profilesPath = path.join(temporaryDirectory, "mixed-config.json");
    await writeFile(
      profilesPath,
      JSON.stringify([
        { id: "claude-valid", name: "Valid", configDir: "./valid" },
        { id: "claude-invalid", name: "Missing config dir" },
      ]),
      "utf8",
    );

    const profiles = await readClaudeCodeProfiles(profilesPath, { HOME: "/custom/home" });

    expect(profiles.map(({ id }) => id)).toEqual(["claude-valid"]);
  });
});
