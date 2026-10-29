import path from "node:path";
import { expect, test, vi } from "vitest";
import { automaticUpdateUnavailableReason } from "@codexhost/update-manager";
import { validateSmokeConfig, runCodexSmoke } from "./codex-host-smoke.mjs";
function config() {
  return {
    authorization: "real-codex-host-smoke",
    installation: "windows-installer",
    root: path.resolve("private-smoke"),
    resourcesRoot: path.resolve("private-install"),
    codexDesktopExecutable: path.resolve("pre-existing-Codex.exe"),
    versions: ["1.2.3", "1.2.4", "1.2.5"].map((version) => ({
      version,
      launcherSha256: "ab".repeat(32),
      updaterSha256: "cd".repeat(32),
      hostSha256: "ef".repeat(32),
    })),
  };
}
test("real smoke plan requires three exact software versions, original channel and explicit authorization", () => {
  expect(validateSmokeConfig(config()).versions).toHaveLength(3);
  for (const change of [
    (c) => {
      delete c.authorization;
    },
    (c) => {
      c.versions.pop();
    },
    (c) => {
      c.versions[1].version = c.versions[0].version;
    },
    (c) => {
      delete c.versions[1].hostSha256;
    },
    (c) => {
      c.installation = "dmg";
    },
    (c) => {
      c.resourcesRoot = "relative";
    },
  ]) {
    const c = config();
    change(c);
    expect(() => validateSmokeConfig(c)).toThrow();
  }
});
test("preparing smoke never opens the production policy", () => {
  for (const kind of ["npm", "windows-installer"])
    expect(automaticUpdateUnavailableReason("win32", kind)).toContain("original");
});
test("unauthorized driver refuses before reading config, compiling or touching Desktop", async () => {
  vi.stubEnv("CODEXHOST_DISPOSABLE_WINDOWS_USER", "not-authorized");
  try {
    await expect(runCodexSmoke("nonexistent.json")).rejects.toThrow(
      "separately authorized disposable Windows",
    );
  } finally {
    vi.unstubAllEnvs();
  }
});
