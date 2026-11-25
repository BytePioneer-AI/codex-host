import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  resolve: vi.fn(),
  target: vi.fn(),
  realpath: vi.fn(),
}));
vi.mock("@codexhost/harness-discovery", async (original) => ({
  ...(await original<object>()),
  runInstallationCommand: mocks.run,
  resolveHarnessExecutable: mocks.target,
}));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<object>()),
  realpath: mocks.realpath,
}));
vi.mock("../src/command.js", () => ({ resolveOmpExecutable: mocks.resolve }));
import { createOmpInstallation } from "../src/installation.js";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolve.mockReturnValue("/chosen/omp");
  mocks.target.mockReturnValue({ executable: "/chosen/omp" });
  mocks.realpath.mockImplementation(async (value: string) => value);
});

describe("OMP native installation", () => {
  it("keeps PATH on the selected installation and preserves the native channel", async () => {
    let version = "1.0.0-canary.1";
    mocks.run.mockImplementation(async (_command, args) => {
      if (args[1] === "--check")
        return `Current version: ${version}\n${version === "1.0.0-canary.1" ? "New version available: 1.0.0-canary.2" : "Already up to date"}`;
      version = "1.0.0-canary.2";
      return "ok";
    });
    await expect(
      createOmpInstallation({ PATH: "/other" }, "/chosen/omp")("update"),
    ).resolves.toMatchObject({ currentVersion: "1.0.0-canary.2", updateAvailable: false });
    expect(mocks.run).toHaveBeenCalledWith(
      "/chosen/omp",
      ["update"],
      { PATH: `/chosen${path.delimiter}/other` },
      300_000,
    );
  });

  it.each(["/other/omp", "/nix/store/omp"])(
    "does not update a mismatched PATH target or Nix install: %s",
    async (target) => {
      mocks.target.mockReturnValue({ executable: target });
      if (target.includes("nix")) mocks.resolve.mockReturnValue(target);
      mocks.run.mockResolvedValue("Current version: 1.0.0\nNew version available: 1.1.0");
      await expect(createOmpInstallation({})("update")).rejects.toThrow("original package manager");
      expect(mocks.run).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects unrecognized native check output", async () => {
    mocks.run.mockResolvedValue("Current version: 1.0.0\nLogin required");
    await expect(createOmpInstallation({})("check")).rejects.toThrow("unknown response");
  });
});
