import { describe, expect, it } from "vitest";

import {
  antigravityUpdateManifestUrl,
  createAntigravityInstallation,
} from "../src/installation.js";

const MANIFEST_ROOT =
  "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";

describe("Antigravity installation updates", () => {
  it.each([
    ["darwin", "arm64", "darwin_arm64"],
    ["darwin", "x64", "darwin_amd64"],
    ["linux", "arm64", "linux_arm64"],
    ["linux", "x64", "linux_amd64"],
    ["win32", "arm64", "windows_arm64"],
    ["win32", "x64", "windows_amd64"],
  ] as const)("reads the official %s %s manifest", (platform, arch, name) => {
    expect(antigravityUpdateManifestUrl(platform, arch)).toBe(`${MANIFEST_ROOT}/${name}.json`);
  });

  it("rejects a platform the official updater does not publish", () => {
    expect(() => antigravityUpdateManifestUrl("freebsd", "x64")).toThrow(
      "unavailable for this platform",
    );
  });

  it("enables update only when the manifest is newer, then installs with agy update", async () => {
    const commands: Array<{ args: readonly string[]; timeout?: number }> = [];
    let installed = "1.2.5\n";
    const installation = createAntigravityInstallation({}, undefined, {
      platform: "darwin",
      arch: "arm64",
      async run(args, timeout) {
        commands.push({ args, ...(timeout !== undefined ? { timeout } : {}) });
        if (args[0] === "update") installed = "1.2.9\n";
        return installed;
      },
      fetchText: async () => JSON.stringify({ version: "1.2.9", url: "https://example.invalid" }),
    });
    await expect(installation("check")).resolves.toEqual({
      currentVersion: "1.2.5",
      latestVersion: "1.2.9",
      updateAvailable: true,
      canUpdate: true,
    });
    await expect(installation("update")).resolves.toEqual({
      currentVersion: "1.2.9",
      latestVersion: "1.2.9",
      updateAvailable: false,
      canUpdate: true,
    });
    expect(commands).toEqual([
      { args: ["--version"] },
      { args: ["--version"] },
      { args: ["update"], timeout: 300_000 },
      { args: ["--version"] },
    ]);
  });

  it("leaves the update button disabled when the installed build is current or newer", async () => {
    const installation = createAntigravityInstallation({}, undefined, {
      platform: "linux",
      arch: "x64",
      run: async () => "1.3.0",
      fetchText: async () => JSON.stringify({ version: "1.2.9" }),
    });
    await expect(installation("check")).resolves.toMatchObject({
      currentVersion: "1.3.0",
      latestVersion: "1.2.9",
      updateAvailable: false,
      canUpdate: true,
    });
    await expect(installation("update")).resolves.toMatchObject({ updateAvailable: false });
  });

  it("reports a manifest that is not the updater document", async () => {
    const installation = createAntigravityInstallation({}, undefined, {
      platform: "win32",
      arch: "x64",
      run: async () => "1.2.9",
      fetchText: async () => "<html>not json</html>",
    });
    await expect(installation("check")).rejects.toThrow(
      "Could not check the latest Antigravity version",
    );
  });
});
