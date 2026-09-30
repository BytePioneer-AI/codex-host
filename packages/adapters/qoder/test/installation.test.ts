import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ run: vi.fn(), resolve: vi.fn() }));
vi.mock("@codexhost/harness-discovery", async (original) => ({
  ...(await original<object>()),
  runInstallationCommand: mocks.run,
}));
vi.mock("../src/qoder-command.js", () => ({ resolveQoderExecutable: mocks.resolve }));
import { createQoderInstallation } from "../src/installation.js";

beforeEach(() => vi.resetAllMocks());

describe("Qoder native version maintenance", () => {
  it("isolates China installation discovery and runs only its native updater", async () => {
    mocks.resolve.mockReturnValue("/chosen/qoderclicn");
    let version = "1.0.0";
    mocks.run.mockImplementation(async (_command, args) => {
      if (args[0] === "--version") return version;
      if (args[1] === "--help") return "--check";
      if (args[1] === "--check")
        return version === "1.0.0" ? "Update available: 1.0.0 -> 1.1.0" : "Already on latest";
      version = "1.1.0";
      return "ok";
    });
    const environment = { CODEXHOST_QODERCN_COMMAND: "/chosen/qoderclicn" };
    await expect(
      createQoderInstallation(environment, "/chosen/qoderclicn", "cn")("update"),
    ).resolves.toMatchObject({ currentVersion: "1.1.0" });
    expect(mocks.resolve).toHaveBeenCalledWith({
      environment,
      command: "/chosen/qoderclicn",
      variant: "cn",
    });
    expect(mocks.run).toHaveBeenCalledWith("/chosen/qoderclicn", ["update"], environment, 300_000);
  });

  it("keeps legacy China releases without --check manual", async () => {
    mocks.resolve.mockReturnValue("/chosen/qoderclicn");
    mocks.run.mockImplementation(async (_command, args) =>
      args[0] === "--version" ? "1.0.0" : "Usage: update",
    );
    await expect(createQoderInstallation({}, undefined, "cn")("check")).resolves.toMatchObject({
      currentVersion: "1.0.0",
      latestVersion: "Unknown",
      canUpdate: false,
    });
    expect(mocks.run.mock.calls.some((call) => call[1][1] === "--check")).toBe(false);
  });

  it("uses native check/update and rejects unfamiliar check output", async () => {
    mocks.resolve.mockReturnValue("/chosen/qoder");
    let version = "1.0.0";
    mocks.run.mockImplementation(async (_command, args) => {
      if (args[0] === "--version") return version;
      if (args[1] === "--check")
        return version === "1.0.0" ? "Update available: 1.0.0 -> 1.1.0" : "Already on latest";
      version = "1.1.0";
      return "ok";
    });
    await expect(createQoderInstallation({})("update")).resolves.toMatchObject({
      currentVersion: "1.1.0",
      updateAvailable: false,
    });
    expect(mocks.run).toHaveBeenCalledWith("/chosen/qoder", ["update"], {}, 300_000);
    mocks.run.mockImplementation(async (_command, args) =>
      args[0] === "--version" ? "1.0.0" : "Login required",
    );
    await expect(createQoderInstallation({})("check")).rejects.toThrow("unknown response");
  });
});
