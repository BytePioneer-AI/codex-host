import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock("@codexhost/harness-discovery", async (original) => ({
  ...(await original<object>()),
  runInstallationCommand: mocks.run,
}));
vi.mock("../src/command.js", () => ({ resolveKiroExecutable: mocks.resolve }));
import { createKiroInstallation } from "../src/installation.js";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolve.mockReturnValue("/chosen/kiro-cli");
  mocks.run.mockResolvedValue("kiro-cli 2.1.0");
});

describe("Kiro installation", () => {
  it("only reads the installed version and gives manual update guidance", async () => {
    const environment = { KIRO_DESKTOP_RELEASE_URL: "https://env.example" };
    await expect(createKiroInstallation(environment, "/chosen/kiro-cli")("check")).resolves.toEqual(
      {
        currentVersion: "2.1.0",
        latestVersion: "Unknown",
        updateAvailable: false,
        canUpdate: false,
        message: expect.stringContaining("native updater"),
        messageCode: "kiro-native-updater",
      },
    );
    expect(mocks.resolve).toHaveBeenCalledWith({ command: "/chosen/kiro-cli", environment });
    expect(mocks.run).toHaveBeenCalledExactlyOnceWith(
      "/chosen/kiro-cli",
      ["--version"],
      environment,
    );
  });

  it("rejects direct update requests without invoking Kiro or fetching metadata", async () => {
    await expect(createKiroInstallation({})("update")).rejects.toThrow("original installer");
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });
});
