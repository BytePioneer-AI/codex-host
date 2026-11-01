import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  fetch: vi.fn(),
  npm: vi.fn(),
  resolve: vi.fn(),
  realpath: vi.fn(),
  read: vi.fn(),
}));
vi.mock("@codexhost/harness-discovery", async (original) => ({
  ...(await original<object>()),
  runInstallationCommand: mocks.run,
  fetchInstallationText: mocks.fetch,
  npmInstallation: mocks.npm,
}));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<object>()),
  realpath: mocks.realpath,
  readFile: mocks.read,
}));
vi.mock("../src/command.js", () => ({ resolveClaudeCodeExecutable: mocks.resolve }));
import { createClaudeInstallation } from "../src/installation.js";

const environment = { HOME: path.resolve("claude-home") };
const executable = path.join(environment.HOME, ".local", "bin", "claude");
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("process", { ...process, platform: "linux" });
  mocks.resolve.mockReturnValue(executable);
  mocks.realpath.mockResolvedValue(
    path.join(environment.HOME, ".local", "share", "claude", "versions", "2.1.0"),
  );
  mocks.read.mockResolvedValue("{}");
  mocks.npm.mockResolvedValue(null);
  mocks.fetch.mockResolvedValue("2.2.0");
  mocks.run.mockResolvedValue("2.1.0 (Claude Code)");
});
afterEach(() => vi.unstubAllGlobals());

describe("Claude installation", () => {
  it("reads the configured stable channel and uses the native policy-aware updater", async () => {
    mocks.read.mockImplementation(async (file: string) =>
      file === path.join(environment.HOME, ".claude", "settings.json")
        ? JSON.stringify({ autoUpdatesChannel: "stable" })
        : "{}",
    );
    let version = "2.1.0";
    mocks.run.mockImplementation(async (_command, args) => {
      if (args[0] === "update") version = "2.2.0";
      return `${version} (Claude Code)`;
    });
    await expect(createClaudeInstallation(environment)("update")).resolves.toMatchObject({
      currentVersion: "2.2.0",
    });
    expect(mocks.fetch).toHaveBeenCalledWith(
      "https://downloads.claude.ai/claude-code-releases/stable",
    );
    expect(mocks.run).toHaveBeenCalledWith(executable, ["--version"], {
      ...environment,
      DISABLE_AUTOUPDATER: "1",
    });
    expect(mocks.run).toHaveBeenCalledWith(executable, ["update"], environment, 300_000);
  });

  it("keeps npm updates on the identified prefix without bypassing native policy checks", async () => {
    mocks.npm.mockResolvedValue({ prefix: "/selected/npm", canUpdate: true });
    mocks.run.mockImplementation(async (_command, args) =>
      args[0] === "update" ? (mocks.run.mockResolvedValue("2.2.0"), "ok") : "2.1.0",
    );
    await createClaudeInstallation(environment)("update");
    expect(mocks.run).toHaveBeenCalledWith(
      executable,
      ["update"],
      { ...environment, npm_config_prefix: "/selected/npm", NPM_CONFIG_PREFIX: "/selected/npm" },
      300_000,
    );
  });

  it.each([
    { env: { DISABLE_UPDATES: "1" } },
    { minimumVersion: "2.3.0" },
    { requiredMaximumVersion: "2.1.0" },
  ])("honors managed update restrictions: %j", async (settings) => {
    mocks.read.mockImplementation(async (file: string) =>
      file === "/etc/claude-code/managed-settings.json" ? JSON.stringify(settings) : "{}",
    );
    await expect(createClaudeInstallation(environment)("update")).rejects.toThrow("restricted");
    expect(mocks.run.mock.calls.every((call) => call[1][0] === "--version")).toBe(true);
  });

  it("does not update a custom launcher or package-manager native binary", async () => {
    mocks.resolve.mockReturnValue("/opt/homebrew/bin/claude");
    await expect(createClaudeInstallation(environment)("check")).resolves.toMatchObject({
      currentVersion: "2.1.0",
      canUpdate: false,
    });
  });

  it("never downgrades a local version newer than its stable channel", async () => {
    mocks.fetch.mockResolvedValue("2.0.0");
    await expect(createClaudeInstallation(environment)("update")).resolves.toMatchObject({
      updateAvailable: false,
    });
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });
});
