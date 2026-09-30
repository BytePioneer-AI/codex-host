import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  fetch: vi.fn(),
  resolve: vi.fn(),
  realpath: vi.fn(),
}));
vi.mock("@codexhost/harness-discovery", async (original) => ({
  ...(await original<object>()),
  runInstallationCommand: mocks.run,
  fetchInstallationText: mocks.fetch,
}));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<object>()),
  realpath: mocks.realpath,
}));
vi.mock("../src/command.js", () => ({ resolveKiroExecutable: mocks.resolve }));
import { createKiroInstallation } from "../src/installation.js";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("process", { ...process, platform: "darwin", arch: "arm64" });
  mocks.resolve.mockReturnValue("/chosen/kiro-cli");
  mocks.realpath.mockResolvedValue(
    path.join("/Applications", "Kiro CLI.app", "Contents", "MacOS", "kiro-cli"),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("Kiro installation", () => {
  it("never runs --check on macOS and selects an eligible release from metadata", async () => {
    let version = "2.1.0";
    mocks.run.mockImplementation(async (_command, args) => {
      if (args[0] === "--version") return version;
      if (args[1] === "--help") return "--non-interactive --rollout";
      if (args[0] === "read") return "https://policy.example/kiro";
      if (args[1] === "--non-interactive") {
        version = "2.2.0";
        return "ok";
      }
      throw new Error("Unexpected command");
    });
    mocks.fetch.mockResolvedValue(
      JSON.stringify({
        versions: [
          {
            version: "2.1.0",
            packages: [{ os: "macos", architecture: "universal", fileType: "dmg" }],
          },
          {
            version: "2.2.0",
            packages: [
              { os: "macos", architecture: "universal", fileType: "dmg", channel: "stable" },
            ],
          },
          {
            version: "9.0.0",
            rollout: { start: Date.now() / 1000 + 86400 },
            packages: [{ architecture: "universal", fileType: "dmg" }],
          },
          {
            version: "8.0.0",
            packages: [{ os: "linux", architecture: "x86_64", fileType: "zip" }],
          },
        ],
      }),
    );
    await expect(
      createKiroInstallation({ KIRO_DESKTOP_RELEASE_URL: "https://env.example" })("update"),
    ).resolves.toMatchObject({ currentVersion: "2.2.0", updateAvailable: false });
    expect(mocks.fetch).toHaveBeenCalledWith("https://policy.example/kiro/index.json");
    expect(mocks.run.mock.calls.some((call) => call[1].includes("--check"))).toBe(false);
    expect(mocks.run).toHaveBeenCalledWith(
      "/chosen/kiro-cli",
      ["update", "--non-interactive"],
      { KIRO_DESKTOP_RELEASE_URL: "https://env.example" },
      300_000,
    );
  });

  it("uses the documented stable endpoint when no override or policy is present", async () => {
    mocks.run.mockImplementation(async (_command, args) =>
      args[0] === "--version"
        ? "2.1.0"
        : args[1] === "--help"
          ? "--non-interactive"
          : Promise.reject(new Error("Missing preference")),
    );
    mocks.fetch.mockResolvedValue(
      JSON.stringify({
        versions: [
          { version: "2.2.0", packages: [{ architecture: "universal", fileType: "dmg" }] },
        ],
      }),
    );
    await createKiroInstallation({})("check");
    expect(mocks.fetch).toHaveBeenCalledWith(
      "https://prod.download.cli.kiro.dev/stable/index.json",
    );
  });

  it("retains native --check on Linux but never upgrades a system-managed install", async () => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    mocks.realpath.mockResolvedValue("/usr/bin/kiro-cli");
    mocks.run.mockImplementation(async (_command, args) =>
      args[0] === "--version"
        ? "2.1.0"
        : args[1] === "--help"
          ? "--check"
          : "New version available: 2.2.0",
    );
    await expect(createKiroInstallation({})("update")).rejects.toThrow("original package manager");
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.run).toHaveBeenCalledWith("/chosen/kiro-cli", ["update", "--check"], {});
  });

  it("rejects unfamiliar update output instead of claiming the installation is current", async () => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    mocks.run.mockImplementation(async (_command, args) =>
      args[0] === "--version" ? "2.1.0" : args[1] === "--help" ? "--check" : "Please sign in",
    );
    await expect(createKiroInstallation({})("check")).rejects.toThrow("unknown response");
  });
});
