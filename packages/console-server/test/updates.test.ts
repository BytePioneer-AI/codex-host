import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import {
  createBackgroundUpdateManager,
  expectedInstallerAssetName,
} from "@codexhost/update-manager";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createConsoleUpdates, type ConsoleUpdateTarget } from "../src/updates.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "codexhost-console-updates-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const release = {
  version: "1.1.0",
  releaseNotes: "Fixes",
  releaseNotesUrl: "https://github.com/BytePioneer-AI/codex-host/releases/tag/v1.1.0",
  assets: [],
};
const releaseWithInstallers = {
  ...release,
  assets: (["windows-x64", "macos-arm64"] as const).map((target) => {
    const name = expectedInstallerAssetName(release.version, target);
    return {
      name,
      size: 1024,
      digest: `sha256:${"a".repeat(64)}`,
      downloadUrl: `https://github.com/BytePioneer-AI/codex-host/releases/download/v${release.version}/${name}`,
    };
  }),
};

const offlineHandoffCases = [
  { platform: "win32", distribution: "npm", target: "windows-x64", installation: "npm" },
  {
    platform: "win32",
    distribution: "installer",
    target: "windows-x64",
    installation: "windows-installer",
  },
  { platform: "darwin", distribution: "npm", target: "macos-arm64", installation: "npm" },
  {
    platform: "darwin",
    distribution: "installer",
    target: "macos-arm64",
    installation: "macos-dmg",
  },
] as const;

async function npmLayout(platform: NodeJS.Platform = process.platform) {
  const packageRoot = path.join(root, "package");
  const appDirectory = path.join(packageRoot, "app");
  await mkdir(path.join(packageRoot, "libexec"), { recursive: true });
  await mkdir(appDirectory, { recursive: true });
  const updater = path.join(
    packageRoot,
    "libexec",
    platform === "win32" ? "codexhost-updater.exe" : "codexhost-updater",
  );
  await writeFile(updater, "updater");
  const npmCli = path.join(root, "npm-cli.js");
  const wrapper = path.join(root, "codexhost.js");
  await writeFile(npmCli, "");
  await writeFile(wrapper, "");
  const target: ConsoleUpdateTarget = {
    distribution: { schemaVersion: 1, version: "1.0.0", distribution: "npm", target: "linux-x64" },
    appDirectory,
    runtimeDescriptorPath: path.join(root, "runtime", "desktop-runtime-v1.json"),
    codexhostRunning: false,
  };
  const environment = {
    CODEXHOST_NPM_NODE_PATH: process.execPath,
    CODEXHOST_NPM_CLI_PATH: npmCli,
    CODEXHOST_NPM_LAUNCHER_PATH: wrapper,
    CODEXHOST_NPM_PACKAGE_ROOT: packageRoot,
  };
  return { target, environment };
}

describe("console updates", () => {
  it("reports an available update from distribution metadata alone", async () => {
    const { target, environment } = await npmLayout("linux");
    const updates = createConsoleUpdates({
      onHandedOff: vi.fn(),
      environment,
      platform: "linux",
      stateDirectory: path.join(root, "state"),
      fetchLatest: async () => release,
    });
    await expect(updates.check(target)).resolves.toMatchObject({
      currentVersion: "1.0.0",
      installation: "npm",
      latestVersion: "1.1.0",
      updateAvailable: true,
      installationAvailable: true,
      error: null,
    });
  });

  it.each(offlineHandoffCases)(
    "reports offline $platform $distribution updates without offering installation",
    async ({ platform, distribution, target: releaseTarget, installation }) => {
      const { target, environment } = await npmLayout(platform);
      target.distribution = {
        schemaVersion: 1,
        version: "1.0.0",
        distribution,
        target: releaseTarget,
      };
      const updates = createConsoleUpdates({
        onHandedOff: vi.fn(),
        environment,
        platform,
        stateDirectory: path.join(root, "state"),
        fetchLatest: async () => releaseWithInstallers,
      });

      await expect(updates.check(target)).resolves.toMatchObject({
        installation,
        latestVersion: "1.1.0",
        updateAvailable: true,
        installationAvailable: false,
        releaseNotes: "Fixes",
        releaseNotesUrl: "https://github.com/BytePioneer-AI/codex-host/releases/tag/v1.1.0",
        error: null,
      });
    },
  );

  it.each(offlineHandoffCases)(
    "rejects offline $platform $distribution starts before acquiring a lock or fetching the release",
    async ({ platform, distribution, target: releaseTarget }) => {
      const { target, environment } = await npmLayout(platform);
      target.distribution = {
        schemaVersion: 1,
        version: "1.0.0",
        distribution,
        target: releaseTarget,
      };
      const fetchLatest = vi.fn(async () => release);
      const stateDirectory = path.join(root, "state");
      const updates = createConsoleUpdates({
        onHandedOff: vi.fn(),
        environment,
        platform,
        stateDirectory,
        fetchLatest,
      });

      await expect(updates.start(target)).rejects.toMatchObject({
        code: "unsupported",
        message: expect.stringContaining("Codex settings"),
      });
      expect(fetchLatest).not.toHaveBeenCalled();
      expect(existsSync(stateDirectory)).toBe(false);
    },
  );

  it("makes the Updater wait for the console process, then hands off", async () => {
    const { target, environment } = await npmLayout("linux");
    const spawnUpdater = vi.fn(() => Object.assign(new EventEmitter(), { pid: 4321 }) as never);
    const onHandedOff = vi.fn();
    const updates = createConsoleUpdates({
      onHandedOff,
      environment,
      platform: "linux",
      processId: 777,
      processExecutable: process.execPath,
      stateDirectory: path.join(root, "state"),
      fetchLatest: async () => release,
      manager: createBackgroundUpdateManager({ platform: "linux", spawnUpdater }),
    });

    await updates.check(target);
    const result = await updates.start(target);

    expect(result.status).toMatchObject({ version: "1.1.0", installation: "npm" });
    await vi.waitFor(() => expect(onHandedOff).toHaveBeenCalledOnce());
    const requestPath = (spawnUpdater.mock.calls[0] as unknown as [string, string])[1];
    const request = JSON.parse(await readFile(requestPath, "utf8")) as Record<string, unknown>;
    expect(request).toMatchObject({
      wait_pid: 777,
      wait_executable: process.execPath,
      runtime_descriptor_path: target.runtimeDescriptorPath,
    });
  });

  it("refuses to update while codexhost is running", async () => {
    const { target, environment } = await npmLayout();
    const updates = createConsoleUpdates({
      onHandedOff: vi.fn(),
      environment,
      stateDirectory: path.join(root, "state"),
      fetchLatest: async () => release,
    });
    await expect(updates.start({ ...target, codexhostRunning: true })).rejects.toMatchObject({
      code: "codex-running",
    });
  });

  it("does not update a source checkout", async () => {
    const { target } = await npmLayout();
    const updates = createConsoleUpdates({
      onHandedOff: vi.fn(),
      stateDirectory: path.join(root, "state"),
      fetchLatest: async () => release,
    });
    await expect(updates.start({ ...target, distribution: null })).rejects.toMatchObject({
      code: "unsupported",
    });
    await expect(updates.check({ ...target, distribution: null })).resolves.toMatchObject({
      updateAvailable: false,
    });
  });
});
