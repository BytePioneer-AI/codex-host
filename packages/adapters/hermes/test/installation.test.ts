import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ run: vi.fn(), resolve: vi.fn() }));
vi.mock("@codexhost/harness-discovery", async (original) => ({
  ...(await original<object>()),
  runInstallationCommand: mocks.run,
}));
vi.mock("../src/command.js", () => ({ resolveHermesExecutable: mocks.resolve }));
import { createHermesInstallation } from "../src/installation.js";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolve.mockReturnValue("/chosen/hermes");
});
const help = "--check --plan --yes --no-gateway-restart";

describe("Hermes native installation", () => {
  it("uses native commit checks and verifies source updates even when the base version is unchanged", async () => {
    let sha = "abc12345";
    mocks.run.mockImplementation(async (_command, args) => {
      if (args[0] === "--version")
        return "Hermes Agent v0.10.0 (2026-09-01)\nInstall directory: /chosen/source\nPython: 3.13.0";
      if (args[0] === "-C") return "";
      if (args[1] === "--help") return help;
      if (args[1] === "--plan") return `Update plan:\n  Install: git (v0.10.0 @ ${sha})`;
      if (args[1] === "--check")
        return sha === "abc12345"
          ? "Update available: 2 commits behind origin/main."
          : "Already up to date.";
      sha = "def12345";
      return "ok";
    });
    await expect(createHermesInstallation({})("update")).resolves.toMatchObject({
      currentVersion: "0.10.0 @ def12345",
      updateAvailable: false,
      messageCode: "hermes-update-channel",
    });
    expect(mocks.run).toHaveBeenCalledWith(
      "/chosen/hermes",
      ["update", "--yes", "--no-gateway-restart"],
      {},
      300_000,
    );
  });

  it.each(["desktop-app", "docker", "nix", "apt"])(
    "keeps %s installations with their native owner",
    async (method) => {
      mocks.run.mockImplementation(async (_command, args) =>
        args[0] === "--version"
          ? "Hermes Agent v0.10.0"
          : args[1] === "--help"
            ? help
            : `Install: ${method}\nNOT updatable in place`,
      );
      await expect(createHermesInstallation({})("check")).resolves.toMatchObject({
        currentVersion: "0.10.0",
        canUpdate: false,
        latestVersion: "Unknown",
        messageCode: "hermes-externally-managed",
      });
      expect(mocks.run.mock.calls.some((call) => call[1][1] === "--check")).toBe(false);
    },
  );

  it("does not force a legacy updater that cannot defer Gateway restarts", async () => {
    mocks.run.mockImplementation(async (_command, args) =>
      args[0] === "--version"
        ? "Hermes Agent v0.10.0"
        : args[1] === "--help"
          ? "--check --plan --yes"
          : args[1] === "--plan"
            ? "Install: git (v0.10.0 @ abc12345)"
            : "Selected release available: v0.11.0",
    );
    await expect(createHermesInstallation({})("update")).rejects.toThrow(
      "Safe non-interactive updates",
    );
    expect(mocks.run.mock.calls.some((call) => call[1].includes("--yes"))).toBe(false);
  });

  it("leaves a modified source checkout for the user to update manually", async () => {
    mocks.run.mockImplementation(async (_command, args) =>
      args[0] === "--version"
        ? "Hermes Agent v0.10.0\nInstall directory: /chosen/source"
        : args[0] === "-C"
          ? " M pyproject.toml"
          : args[1] === "--help"
            ? help
            : args[1] === "--plan"
              ? "Install: git (v0.10.0 @ abc12345)"
              : "Update available: 2 commits behind origin/main.",
    );
    await expect(createHermesInstallation({})("update")).rejects.toThrow("clean source checkout");
    expect(mocks.run.mock.calls.some((call) => call[1].includes("--yes"))).toBe(false);
  });

  it.each(["git is unavailable", "dubious ownership", "not a git repository"])(
    "retains version information and keeps updates manual when status fails: %s",
    async (error) => {
      mocks.run.mockImplementation(async (_command, args) => {
        if (args[0] === "--version")
          return "Hermes Agent v0.10.0\nInstall directory: /chosen/source";
        if (args[0] === "-C") throw new Error(error);
        if (args[1] === "--help") return help;
        if (args[1] === "--plan") return "Install: git (v0.10.0 @ abc12345)";
        return "Selected release available: v0.11.0";
      });
      const installation = createHermesInstallation({});
      await expect(installation("check")).resolves.toMatchObject({
        currentVersion: "0.10.0 @ abc12345",
        latestVersion: "v0.11.0",
        updateAvailable: true,
        canUpdate: false,
        message: expect.stringContaining("native updater manually"),
        messageCode: "hermes-manual-update",
      });
      await expect(installation("update")).rejects.toThrow("clean source checkout");
      expect(mocks.run.mock.calls.some((call) => call[1].includes("--yes"))).toBe(false);
    },
  );

  it("returns a structured tracking-branch hint when native checks find new commits", async () => {
    mocks.run.mockImplementation(async (_command, args) =>
      args[0] === "--version"
        ? "Hermes Agent v0.10.0"
        : args[1] === "--help"
          ? help
          : args[1] === "--plan"
            ? "Install: git (v0.10.0 @ abc12345)"
            : "Update available: 2 commits behind origin/main.",
    );
    await expect(createHermesInstallation({})("check")).resolves.toMatchObject({
      latestVersionKind: "tracking-branch",
      messageCode: "hermes-manual-update",
      updateAvailable: true,
      canUpdate: false,
    });
  });

  it("does not mistake Python's version for the Harness version", async () => {
    mocks.run.mockResolvedValue("Python: 3.13.0");
    await expect(createHermesInstallation({})("check")).rejects.toThrow("unknown version response");
  });
});
