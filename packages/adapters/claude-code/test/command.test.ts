import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveClaudeCodeExecutable } from "../src/command.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

function fakeExecutable(): { directory: string; executable: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codexhost-claude-adapter-"));
  directories.push(directory);
  const executable = path.join(directory, process.platform === "win32" ? "claude.exe" : "claude");
  fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  return { directory, executable };
}

describe("Claude Code executable resolution", () => {
  it("uses an explicit command", () => {
    const { executable } = fakeExecutable();
    expect(
      resolveClaudeCodeExecutable({ command: executable, environment: {}, platform: "darwin" }),
    ).toBe(executable);
  });

  it("resolves from PATH", () => {
    const { directory, executable } = fakeExecutable();
    expect(
      resolveClaudeCodeExecutable({
        environment: { PATH: directory, PATHEXT: ".exe" },
        platform: process.platform,
      }),
    ).toBe(executable);
  });

  it("resolves the Windows npm shim to Claude Code's native executable", () => {
    const homeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "codexhost-claude-home-"));
    directories.push(homeDirectory);
    const appData = path.join(homeDirectory, "AppData", "Roaming");
    const npmDirectory = path.join(appData, "npm");
    const shim = path.join(npmDirectory, "claude.cmd");
    const nativeExecutable = path.join(
      npmDirectory,
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "bin",
      "claude.exe",
    );
    fs.mkdirSync(path.dirname(nativeExecutable), { recursive: true });
    fs.writeFileSync(shim, "@echo off\r\n", { mode: 0o700 });
    fs.writeFileSync(nativeExecutable, "native Claude Code", { mode: 0o700 });

    expect(
      resolveClaudeCodeExecutable({
        environment: { APPDATA: appData, PATH: npmDirectory, PATHEXT: ".CMD" },
        homeDirectory,
        platform: "win32",
      }),
    ).toBe(nativeExecutable);
  });

  it("rejects a Windows npm shim without a native executable", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codexhost-claude-npm-"));
    directories.push(directory);
    const shim = path.join(directory, "claude.cmd");
    fs.writeFileSync(shim, "@echo off\r\n", { mode: 0o700 });

    expect(() =>
      resolveClaudeCodeExecutable({
        command: shim,
        environment: {},
        platform: "win32",
      }),
    ).toThrow("not installed");
  });

  it("finds a user npm installation when a Finder-style PATH omits it", () => {
    const homeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "codexhost-claude-home-"));
    directories.push(homeDirectory);
    const executable = path.join(homeDirectory, ".npm-global", "bin", "claude");
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, "#!/usr/bin/env node\nexit 0\n", { mode: 0o700 });

    expect(
      resolveClaudeCodeExecutable({
        environment: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
        homeDirectory,
        platform: "darwin",
      }),
    ).toBe(executable);
  });

  it("finds a user NVM installation when a Finder-style PATH omits it", () => {
    const homeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "codexhost-claude-home-"));
    directories.push(homeDirectory);
    const executable = path.join(
      homeDirectory,
      ".nvm",
      "versions",
      "node",
      "v24.18.0",
      "bin",
      "claude",
    );
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });

    expect(
      resolveClaudeCodeExecutable({
        environment: { PATH: "" },
        homeDirectory,
        platform: "darwin",
      }),
    ).toBe(executable);
  });

  it("fails without substituting the SDK bundled binary", () => {
    const homeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "codexhost-claude-home-"));
    directories.push(homeDirectory);
    expect(() =>
      resolveClaudeCodeExecutable({
        environment: { PATH: "" },
        homeDirectory,
        platform: "linux",
      }),
    ).toThrow("not installed");
  });
});
