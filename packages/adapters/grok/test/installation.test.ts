import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ run: vi.fn(), resolve: vi.fn(), launcher: vi.fn() }));
vi.mock("@codexhost/harness-discovery", async (original) => ({
  ...(await original<object>()),
  runInstallationCommand: mocks.run,
  readLauncherScript: mocks.launcher,
}));
vi.mock("../src/command.js", () => ({ resolveGrokExecutable: mocks.resolve }));
import { createGrokInstallation } from "../src/installation.js";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolve.mockReturnValue("/chosen/grok");
  mocks.launcher.mockResolvedValue("");
});

describe("Grok native version maintenance", () => {
  it.each(["check", "update"] as const)(
    "keeps grokgod %s read-only and reports patch-manager ownership",
    async (action) => {
      mocks.launcher.mockResolvedValue(
        '#!/bin/sh\nGROKGOD_HOME="${GROKGOD_HOME:-$HOME/.grokgod}"\nGROKGOD_BIN="$GROKGOD_HOME/bin/grok"',
      );
      mocks.run.mockResolvedValue("grok 1.0.6 (patched)");
      const result = await createGrokInstallation({ HOME: "/user" })(action);
      expect(result).toMatchObject({
        currentVersion: "1.0.6",
        latestVersion: "Unknown",
        latestVersionKind: "unknown",
        canUpdate: false,
        updateAvailable: false,
        notice: { en: expect.stringContaining("Managed by grokgod") },
      });
      expect(mocks.run).toHaveBeenCalledExactlyOnceWith(
        "/chosen/grok",
        ["--version"],
        {
          HOME: "/user",
          GROK_DISABLE_AUTOUPDATER: "1",
          GROKGOD_UPDATE_CHECK_DISABLE: "1",
        },
        undefined,
      );
    },
  );

  it("does not attempt a stock update check if the launcher cannot be read", async () => {
    mocks.launcher.mockRejectedValue(new Error("unreadable launcher"));
    await expect(createGrokInstallation({})("check")).rejects.toThrow("unreadable launcher");
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it.each(["native", "npm"])(
    "preserves the %s installer and verifies version after updating",
    async (installer) => {
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
