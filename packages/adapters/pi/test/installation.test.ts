import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ run: vi.fn(), fetch: vi.fn(), resolve: vi.fn() }));
vi.mock("@codexhost/harness-discovery", async (original) => ({
  ...(await original<object>()),
  runInstallationCommand: mocks.run,
  fetchInstallationText: mocks.fetch,
}));
vi.mock("../src/command.js", () => ({ resolvePiExecutable: mocks.resolve }));
import { createPiInstallation } from "../src/installation.js";

describe("Pi native version maintenance", () => {
  it("uses the selected installation and pi update, not an unrelated npm prefix", async () => {
    const environment = { CODEXHOST_PI_COMMAND: "/chosen/pi" };
    mocks.resolve.mockReturnValue("/chosen/pi");
    mocks.fetch.mockResolvedValue(JSON.stringify({ version: "0.85.2" }));
    let version = "0.85.1";
    mocks.run.mockImplementation(async (_command, args) => {
      if (args[0] === "update") version = "0.85.2";
      return version;
    });
    const installation = createPiInstallation(environment, "/chosen/pi");
    await expect(installation("update")).resolves.toMatchObject({
      currentVersion: "0.85.2",
      updateAvailable: false,
    });
    expect(mocks.fetch).toHaveBeenCalledWith("https://pi.dev/api/latest-version");
    expect(mocks.run).toHaveBeenCalledWith("/chosen/pi", ["update"], environment, 300_000);
  });
});
