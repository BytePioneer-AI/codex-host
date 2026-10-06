import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  fetch: vi.fn(),
  npm: vi.fn(),
  resolve: vi.fn(),
  realpath: vi.fn(),
  update: vi.fn(),
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
}));
vi.mock("../src/command.js", () => ({ resolveOpenCodeExecutable: mocks.resolve }));
import { createOpenCodeInstallation } from "../src/installation.js";

const home = path.resolve("opencode-home");
const executable = path.join(home, ".opencode", "bin", "opencode");
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("process", { ...process, platform: "linux" });
  mocks.resolve.mockReturnValue(executable);
  mocks.realpath.mockImplementation(async (value: string) => value);
  mocks.npm.mockResolvedValue(null);
  mocks.fetch.mockResolvedValue(JSON.stringify({ tag_name: "v1.1.0" }));
  mocks.run.mockResolvedValue("1.0.0");
});
afterEach(() => vi.unstubAllGlobals());

describe("OpenCode installation", () => {
  it("uses a fixed non-interactive method only for the standard native install", async () => {
    let version = "1.0.0";
    mocks.run.mockImplementation(async (_command, args) => {
      if (args[0] === "upgrade") version = "1.1.0";
      return version;
    });
    const environment = { HOME: home };
    await expect(createOpenCodeInstallation(environment)("update")).resolves.toMatchObject({
      currentVersion: "1.1.0",
    });
    expect(mocks.run).toHaveBeenCalledWith(
      path.join(environment.HOME, ".opencode/bin/opencode"),
      ["upgrade", "1.1.0", "--method", "curl"],
      environment,
      300_000,
    );
  });

  it("uses the identified npm prefix rather than native upgrade's global npm discovery", async () => {
    mocks.npm.mockResolvedValue({
      canUpdate: true,
      latest: async () => "1.1.0",
      update: mocks.update,
    });
    mocks.update.mockImplementation(async () => mocks.run.mockResolvedValue("1.1.0"));
    await createOpenCodeInstallation({})("update");
    expect(mocks.update).toHaveBeenCalledWith("1.1.0");
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.run.mock.calls.every((call) => call[1][0] === "--version")).toBe(true);
  });

  it("does not let unknown or symlinked installations enter the interactive upgrade fallback", async () => {
    mocks.realpath.mockResolvedValue("/opt/brew/opencode");
    await expect(createOpenCodeInstallation({ HOME: home })("update")).rejects.toThrow(
      "original package manager",
    );
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });

  it("does not report success when native upgrade leaves the selected version unchanged", async () => {
    await expect(createOpenCodeInstallation({ HOME: home })("update")).rejects.toThrow(
      "version did not change",
    );
  });
});
