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

  it.each(["failed", "succeeded", "prepared"])("does not display historical %s state", async (phase) => {
    const { target, environment } = await npmLayout();
    const stateDirectory = path.join(root, "state");
    const directory = path.join(stateDirectory, "update-old");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "status-v1.json"), JSON.stringify({
      schemaVersion: 1, version: "1.1.0", installation: "npm", phase,
      updatedAt: Math.floor(Date.now() / 1000), error: "old failure",
    }));
    const updates = createConsoleUpdates({
      onHandedOff: vi.fn(), environment, stateDirectory, fetchLatest: async () => release,
    });
    await expect(updates.check(target)).resolves.toMatchObject({ status: null });
    await expect(updates.status()).resolves.toEqual({ status: null });
  });

  it("recovers the locked task and keeps its result after completion", async () => {
    const { environment } = await npmLayout();
    const stateDirectory = path.join(root, "state");
    const directory = path.join(stateDirectory, "update-active");
    const statusPath = path.join(directory, "status-v1.json");
    await mkdir(directory, { recursive: true });
    const status = { schemaVersion: 1, version: "1.1.0", installation: "npm",
      phase: "prepared", updatedAt: Math.floor(Date.now() / 1000) };
    await writeFile(statusPath, JSON.stringify(status));
    await writeFile(path.join(stateDirectory, "active-update-v1.lock"), JSON.stringify({
      ownerPid: process.pid, statusPath,
    }));
    const options = { onHandedOff: vi.fn(), environment, stateDirectory, fetchLatest: async () => release };
    const updates = createConsoleUpdates(options);
    await expect(updates.status()).resolves.toMatchObject({ status: { phase: "prepared" } });
    await writeFile(statusPath, JSON.stringify({ ...status, phase: "failed", error: "current failure" }));
    await expect(updates.status()).resolves.toMatchObject({ status: { phase: "failed", error: "current failure" } });
    await expect(createConsoleUpdates(options).status()).resolves.toEqual({ status: null });
  });

  it("hands off to the Updater before returning", async () => {
    const { target, environment } = await npmLayout("linux");
    const spawnUpdater = vi.fn<(executable: string, requestPath: string) => never>(
      () => Object.assign(new EventEmitter(), { pid: 4321, kill: vi.fn() }) as never,
    );
    const onHandedOff = vi.fn();
    const updates = createConsoleUpdates({
      onHandedOff,
      waitForHandoff: true,
      environment,
      platform: "linux",
      processId: 777,
      processExecutable: process.execPath,
      stateDirectory: path.join(root, "state"),
      fetchLatest: async () => release,
      manager: createBackgroundUpdateManager({ platform: "linux", spawnUpdater }),
    });

    await updates.check(target);
    const starting = updates.start(target);
    await vi.waitFor(() => expect(spawnUpdater).toHaveBeenCalledOnce());
    expect(onHandedOff).not.toHaveBeenCalled();
    const call = spawnUpdater.mock.calls[0];
    if (!call) throw new Error("Updater was not spawned");
    const spawnedRequest = JSON.parse(await readFile(call[1], "utf8"));
    const status = JSON.parse(await readFile(spawnedRequest.status_path, "utf8"));
    await writeFile(
      spawnedRequest.status_path,
      JSON.stringify({ ...status, phase: "waiting-for-exit" }),
    );
    const result = await starting;

    expect(result.status.phase).toBe("waiting-for-exit");
    expect(result.status).toMatchObject({ version: "1.1.0", installation: "npm" });
    expect(onHandedOff).toHaveBeenCalledOnce();
    const requestPath = (spawnUpdater.mock.calls[0] as unknown as [string, string])[1];
    const request = JSON.parse(await readFile(requestPath, "utf8")) as Record<string, unknown>;
    expect(request).toMatchObject({
      wait_pid: 777,
      wait_executable: process.execPath,
      runtime_descriptor_path: target.runtimeDescriptorPath,
    });
  });

  it("shows the current preparation failure and replaces it when retrying", async () => {
    const { target, environment } = await npmLayout("linux");
    await rm(environment.CODEXHOST_NPM_CLI_PATH);
    const onHandedOff = vi.fn();
    const spawnUpdater = vi.fn<(executable: string, requestPath: string) => never>(
      () => Object.assign(new EventEmitter(), { pid: 4321, kill: vi.fn() }) as never,
    );
    const updates = createConsoleUpdates({
      onHandedOff,
      waitForHandoff: true,
      environment,
      platform: "linux",
      stateDirectory: path.join(root, "state"),
      fetchLatest: async () => release,
      manager: createBackgroundUpdateManager({
        platform: "linux",
        spawnUpdater,
      }),
    });
    await expect(updates.start(target)).rejects.toThrow();
    expect(onHandedOff).not.toHaveBeenCalled();
    await expect(updates.status()).resolves.toMatchObject({ status: { phase: "failed" } });
    await writeFile(environment.CODEXHOST_NPM_CLI_PATH, "");
    const retry = updates.start(target);
    await vi.waitFor(() => expect(spawnUpdater).toHaveBeenCalledOnce());
    const call = spawnUpdater.mock.calls[0];
    if (!call) throw new Error("Updater was not spawned");
    const request = JSON.parse(await readFile(call[1], "utf8"));
    const status = JSON.parse(await readFile(request.status_path, "utf8"));
    await writeFile(request.status_path, JSON.stringify({ ...status, phase: "waiting-for-exit" }));
    await expect(retry).resolves.toMatchObject({ status: { phase: "waiting-for-exit" } });
    await expect(updates.status()).resolves.toMatchObject({
      status: { phase: "waiting-for-exit", error: null },
    });
  });

  it.each(["error", "exit"])("does not hand off after an Updater %s", async (event) => {
    const { target, environment } = await npmLayout("linux");
    const onHandedOff = vi.fn();
    const child = Object.assign(new EventEmitter(), { pid: 4321, kill: vi.fn() });
    const updates = createConsoleUpdates({
      onHandedOff,
      waitForHandoff: true,
      environment,
      platform: "linux",
      stateDirectory: path.join(root, "state"),
      fetchLatest: async () => release,
      manager: createBackgroundUpdateManager({
        platform: "linux",
        spawnUpdater: () => {
          queueMicrotask(() => child.emit(event, new Error("spawn failed")));
          return child as never;
        },
      }),
    });
    await expect(updates.start(target)).rejects.toThrow();
    expect(onHandedOff).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledOnce();
    await expect(updates.status()).resolves.toMatchObject({ status: { phase: "failed" } });
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
  it("reports the source launch version without enabling packaged updates", async () => {
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "codexhost", version: "0.12.0" }),
    );
    const updates = createConsoleUpdates({
      environment: { CODEXHOST_DEV_VERSION: "0.11.0" },
      onHandedOff: vi.fn(),
    });
    await expect(
      updates.check({
        distribution: null,
        appDirectory: path.join(root, "packages/console-server/dist"),
        runtimeDescriptorPath: null,
        codexhostRunning: false,
      }),
    ).resolves.toMatchObject({
      currentVersion: "0.11.0",
      installation: null,
      installationAvailable: false,
    });
  });
});
