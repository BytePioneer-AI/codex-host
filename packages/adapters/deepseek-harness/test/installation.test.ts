import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ run: vi.fn(), npm: vi.fn(), resolve: vi.fn(), update: vi.fn() }));
vi.mock("@codexhost/harness-discovery", async (original) => ({
  ...(await original<object>()),
  runInstallationCommand: mocks.run,
  npmInstallation: mocks.npm,
}));
vi.mock("../src/executable.js", () => ({ resolveDeepSeekCommand: mocks.resolve }));
import { createDeepSeekInstallation } from "../src/installation.js";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolve.mockReturnValue({ command: "/chosen/dsh", arguments: [], kind: "dsh" });
  mocks.run.mockResolvedValue("0.2.0-rc.2");
});

describe("DeepSeek installation", () => {
  it("updates identified global npm installs including newer prereleases", async () => {
    mocks.npm.mockResolvedValue({
      canUpdate: true,
      latest: async () => "0.2.0-rc.3",
      update: mocks.update,
    });
    mocks.update.mockImplementation(async () => mocks.run.mockResolvedValue("0.2.0-rc.3"));
    await expect(createDeepSeekInstallation({}, "/chosen/dsh")("update")).resolves.toMatchObject({
      currentVersion: "0.2.0-rc.3",
      updateAvailable: false,
    });
    expect(mocks.npm).toHaveBeenCalledWith("/chosen/dsh", ["@deepseek-ai/dsh"], {});
    expect(mocks.update).toHaveBeenCalledWith("0.2.0-rc.3");
  });

  it("preserves offline npx invocation and never creates a different global installation", async () => {
    mocks.resolve.mockReturnValue({
      command: "/chosen/npx",
      arguments: ["--offline", "--no-install", "@deepseek-ai/dsh"],
      kind: "npx",
    });
    await expect(createDeepSeekInstallation({})("check")).resolves.toMatchObject({
      currentVersion: "0.2.0-rc.2",
      latestVersion: "Unknown",
      canUpdate: false,
    });
    expect(mocks.run).toHaveBeenCalledWith(
      "/chosen/npx",
      ["--offline", "--no-install", "@deepseek-ai/dsh", "--version"],
      {},
    );
    expect(mocks.npm).not.toHaveBeenCalled();
  });

  it("does not upgrade project-local, Python, or desktop installations with global npm", async () => {
    mocks.npm.mockResolvedValue({
      canUpdate: false,
      latest: async () => "0.2.0",
      update: mocks.update,
    });
    await expect(createDeepSeekInstallation({})("update")).rejects.toThrow("original installer");
    expect(mocks.update).not.toHaveBeenCalled();
    mocks.npm.mockResolvedValue(null);
    await expect(createDeepSeekInstallation({})("check")).resolves.toMatchObject({
      canUpdate: false,
      latestVersion: "Unknown",
    });
  });
});
