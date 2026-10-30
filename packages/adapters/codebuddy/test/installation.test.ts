import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ run: vi.fn(), npm: vi.fn(), resolve: vi.fn(), update: vi.fn() }));
vi.mock("@codexhost/harness-discovery", async (original) => ({
  ...(await original<object>()),
  runInstallationCommand: mocks.run,
  npmInstallation: mocks.npm,
  resolveHarnessExecutable: mocks.resolve,
}));
import { createCodeBuddyInstallation } from "../src/installation.js";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolve.mockReturnValue({ executable: "/chosen/codebuddy" });
  mocks.run.mockResolvedValue("2.1.0");
});

describe("CodeBuddy npm installation", () => {
  it("updates only the identified global package", async () => {
    mocks.npm.mockResolvedValue({
      canUpdate: true,
      latest: async () => "2.2.0",
      update: mocks.update,
    });
    mocks.update.mockImplementation(async () => mocks.run.mockResolvedValue("2.2.0"));
    await expect(createCodeBuddyInstallation({})("update")).resolves.toMatchObject({
      currentVersion: "2.2.0",
    });
    expect(mocks.npm).toHaveBeenCalledWith("/chosen/codebuddy", ["@tencent-ai/codebuddy-code"], {});
    expect(mocks.update).toHaveBeenCalledWith("2.2.0");
  });

  it("still checks project-local npm installs but keeps their update manual", async () => {
    mocks.npm.mockResolvedValue({
      canUpdate: false,
      latest: async () => "2.2.0",
      update: mocks.update,
    });
    await expect(createCodeBuddyInstallation({})("check")).resolves.toMatchObject({
      currentVersion: "2.1.0",
      latestVersion: "2.2.0",
      canUpdate: false,
    });
    await expect(createCodeBuddyInstallation({})("update")).rejects.toThrow(
      "original package manager",
    );
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("does not advertise an npm release as a native installation's latest version", async () => {
    mocks.npm.mockResolvedValue(null);
    await expect(createCodeBuddyInstallation({})("check")).resolves.toMatchObject({
      currentVersion: "2.1.0",
      latestVersion: "Unknown",
      canUpdate: false,
    });
    expect(mocks.run).toHaveBeenCalledWith("/chosen/codebuddy", ["--version"], {});
  });
});
