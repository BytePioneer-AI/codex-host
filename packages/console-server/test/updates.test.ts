import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { createBackgroundUpdateManager } from "@codexhost/update-manager";
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

async function npmLayout() {
  const packageRoot = path.join(root, "package");
  const appDirectory = path.join(packageRoot, "app");
  await mkdir(path.join(packageRoot, "libexec"), { recursive: true });
  await mkdir(appDirectory, { recursive: true });
  const updater = path.join(
    packageRoot,
    "libexec",
    process.platform === "win32" ? "codexhost-updater.exe" : "codexhost-updater",
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
    const { target, environment } = await npmLayout();
    const updates = createConsoleUpdates({
      onHandedOff: vi.fn(),
      environment,
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

  it("makes the Updater wait for the console process, then hands off", async () => {
    const { target, environment } = await npmLayout();
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
