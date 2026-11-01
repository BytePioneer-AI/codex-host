import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ run: vi.fn(), resolve: vi.fn() }));
vi.mock("@codexhost/harness-discovery", async (original) => ({
  ...(await original<object>()),
  runInstallationCommand: mocks.run,
}));
vi.mock("../src/command.js", () => ({ resolveGrokExecutable: mocks.resolve }));
import { createGrokInstallation } from "../src/installation.js";

describe("Grok native version maintenance", () => {
  it.each(["native", "npm"])(
    "preserves the %s installer and verifies version after updating",
    async (installer) => {
      mocks.run.mockClear();
      mocks.resolve.mockReturnValue("/chosen/grok");
      let updated = false;
      mocks.run.mockImplementation(async (_command, args) => {
        if (!args.includes("--check")) {
          updated = true;
          return "ok";
        }
        return JSON.stringify({
          currentVersion: updated ? "1.1.0" : "1.0.0",
          latestVersion: "1.1.0",
          updateAvailable: !updated,
          installer,
        });
      });
      const environment = { npm_config_allow_scripts: "existing-package" };
      await expect(createGrokInstallation(environment)("update")).resolves.toMatchObject({
        updateAvailable: false,
      });
      expect(mocks.run).toHaveBeenCalledWith(
        "/chosen/grok",
        installer === "npm" ? ["update", "--force-reinstall"] : ["update"],
        installer === "npm"
          ? { npm_config_allow_scripts: "existing-package,@xai-official/grok" }
          : environment,
        300_000,
      );
    },
  );
});
