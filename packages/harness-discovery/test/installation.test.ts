import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createInstallationManager,
  installationVersion,
  newerInstallationVersion,
  readLauncherScript,
  runInstallationCommand,
} from "../src/installation.js";

const state = (current = "1.0.0", canUpdate = true) => ({
  currentVersion: current,
  latestVersion: "1.1.0",
  updateAvailable: current === "1.0.0",
  canUpdate,
});

describe("Harness installation versions", () => {
  it("reads only a launcher prefix and ignores native binary contents", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-launcher-"));
    try {
      const launcher = path.join(root, "grok");
      await writeFile(launcher, `#!/bin/sh\nGROKGOD_HOME=custom\n${"x".repeat(8192)}`);
      const text = await readLauncherScript(launcher);
      expect(text).toHaveLength(4096);
      expect(text).toContain("GROKGOD_HOME=custom");
      const native = path.join(root, "native");
      await writeFile(native, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0]));
      expect(await readLauncherScript(native)).toBe("");
      const windows = path.join(root, "grok.cmd");
      await writeFile(windows, "@echo off\r\nset GROKGOD_HOME=custom\r\n");
      expect(await readLauncherScript(windows)).toContain("GROKGOD_HOME=custom");
      await expect(readLauncherScript(path.join(root, "missing"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("validates versions and never downgrades a newer local build", () => {
    expect(installationVersion("v1.2.3")).toBe("1.2.3");
    expect(newerInstallationVersion("1.2.3", "1.2.2")).toBe(false);
    expect(newerInstallationVersion("1.2.3-dev", "1.2.3")).toBe(true);
    expect(newerInstallationVersion("2026.09.23-abc", "2026.09.24-def")).toBe(true);
    expect(() => installationVersion("latest")).toThrow("invalid version");
    expect(() => installationVersion("1.2.3; echo secret")).toThrow();
  });

  it.each([
    ["0.2.0-rc.2", "0.2.0-rc.3", true],
    ["0.2.0-rc.10", "0.2.0-rc.2", false],
    ["0.2.0", "0.2.0-rc.3", false],
    ["0.2.0-rc.3", "0.2.0", true],
    ["0.2.0-1", "0.2.0-alpha", true],
    ["0.2.0-rc", "0.2.0-rc.1", true],
    ["1.2.3+local", "1.2.3+other", false],
    ["1.2.3-rc.2+local", "1.2.3-rc.3+other", true],
  ])("orders %s against %s without a downgrade", (current, latest, expected) => {
    expect(newerInstallationVersion(current, latest)).toBe(expected);
  });

  it("coalesces concurrent checks and updates, and verifies the installed version", async () => {
    const gate = Promise.withResolvers<undefined>();
    let version = "1.0.0";
    const check = vi.fn(async () => state(version));
    const update = vi.fn(async () => {
      await gate.promise;
      version = "1.1.0";
    });
    const installation = createInstallationManager({ check, update });
    const first = installation("check");
    expect(installation("check")).toBe(first);
    await first;
    const updating = installation("update");
    expect(installation("update")).toBe(updating);
    expect(installation("check")).toBe(updating);
    gate.resolve(undefined);
    await expect(updating).resolves.toEqual(state("1.1.0"));
    expect(update).toHaveBeenCalledOnce();
    expect(check).toHaveBeenCalledTimes(3);
  });

  it("does not run an updater when current or the installation is manual", async () => {
    const update = vi.fn(async () => undefined);
    await createInstallationManager({ check: async () => state("1.1.0"), update })("update");
    expect(update).not.toHaveBeenCalled();
    await expect(
      createInstallationManager({ check: async () => state("1.0.0", false), update })("update"),
    ).rejects.toThrow("cannot be updated automatically");
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects unchanged versions and allows a new check after failure", async () => {
    const check = vi.fn(async () => state());
    const installation = createInstallationManager({ check, update: async () => undefined });
    await expect(installation("update")).rejects.toThrow("version did not change");
    await expect(installation("check")).resolves.toEqual(state());
    expect(check).toHaveBeenCalledTimes(3);
  });

  it("bounds native commands and does not leak stderr into failures", async () => {
    await expect(
      runInstallationCommand(
        process.execPath,
        ["-e", "process.stderr.write('secret-token');process.exit(1)"],
        process.env,
      ),
    ).rejects.toThrow("Harness command failed; check the native installation and retry");
    await expect(
      runInstallationCommand(
        process.execPath,
        ["-e", "setInterval(()=>{},1000)"],
        process.env,
        100,
      ),
    ).rejects.toThrow("timed out");
  });
});
