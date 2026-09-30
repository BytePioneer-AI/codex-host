import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ run: vi.fn(), resolve: vi.fn() }));
vi.mock("@codexhost/harness-discovery", async (original) => ({
  ...(await original<object>()),
  runInstallationCommand: mocks.run,
}));
vi.mock("../src/qoder-command.js", () => ({ resolveQoderExecutable: mocks.resolve }));
import { createQoderInstallation } from "../src/installation.js";

describe("Qoder native version maintenance", () => {
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
