import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createBackgroundUpdateManager,
  type CodexhostLatestRelease,
} from "@codexhost/update-manager";

import {
  createHostUpdateCoordinator,
  startCompatibilityUpdate,
} from "../src/update-coordinator.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true }))));

async function file(filePath: string, contents = "fixture"): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents);
  await chmod(filePath, 0o700);
}

async function npmFixture(): Promise<{
  root: string;
  hostRuntimePath: string;
  environment: NodeJS.ProcessEnv;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-host-update-"));
  roots.push(root);
  const packageRoot = path.join(root, "platform");
  const hostRuntimePath = path.join(packageRoot, "app", "host-runtime.mjs");
  const environment = {
    HOME: path.join(root, "home"),
    CODEXHOST_LAUNCHER_PID: "4321",
    CODEXHOST_LAUNCHER_EXECUTABLE: path.join(root, "codexhost"),
    CODEXHOST_CONTROL_PORT: "43124",
    CODEXHOST_CONTROL_NONCE: "0123456789abcdef0123456789abcdef",
    CODEXHOST_NPM_NODE_PATH: path.join(root, "node"),
    CODEXHOST_NPM_CLI_PATH: path.join(root, "npm-cli.js"),
    CODEXHOST_NPM_LAUNCHER_PATH: path.join(root, "codexhost.js"),
    CODEXHOST_NPM_PACKAGE_ROOT: packageRoot,
  };
  await Promise.all([
    file(hostRuntimePath),
    file(path.join(packageRoot, "libexec", "codexhost-updater")),
    file(environment.CODEXHOST_LAUNCHER_EXECUTABLE),
    file(environment.CODEXHOST_NPM_NODE_PATH),
    file(environment.CODEXHOST_NPM_CLI_PATH),
    file(environment.CODEXHOST_NPM_LAUNCHER_PATH),
    file(
      path.join(packageRoot, "app", "codexhost-distribution.json"),
      JSON.stringify({
        schemaVersion: 1,
        version: "1.2.2",
        distribution: "npm",
        target: "macos-arm64",
      }),
    ),
  ]);
  return { root, hostRuntimePath, environment };
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function macFixture(): Promise<{
  root: string;
  hostRuntimePath: string;
  environment: NodeJS.ProcessEnv;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-host-mac-update-"));
  roots.push(root);
  const app = path.join(root, "codexhost.app");
  const resources = path.join(app, "Contents", "Resources");
  const hostRuntimePath = path.join(resources, "app", "host-runtime.mjs");
  const environment = {
    HOME: path.join(root, "home"),
    CODEXHOST_LAUNCHER_PID: "4321",
    CODEXHOST_LAUNCHER_EXECUTABLE: path.join(root, "codexhost"),
    CODEXHOST_CONTROL_PORT: "43124",
    CODEXHOST_CONTROL_NONCE: "0123456789abcdef0123456789abcdef",
  };
  await Promise.all([
    file(hostRuntimePath),
    file(path.join(resources, "libexec", "codexhost-updater")),
    file(environment.CODEXHOST_LAUNCHER_EXECUTABLE),
    file(
      path.join(resources, "app", "codexhost-distribution.json"),
      JSON.stringify({
        schemaVersion: 1,
        version: "1.2.2",
        distribution: "installer",
        target: "macos-arm64",
      }),
    ),
  ]);
  return { root, hostRuntimePath, environment };
}

function release(version = "1.2.3"): CodexhostLatestRelease {
  return {
    version,
    releaseNotes: `Release ${version}`,
    releaseNotesUrl: `https://github.com/BytePioneer-AI/codex-host/releases/tag/v${version}`,
    assets: [],
  };
}

describe("Host update coordinator", () => {
  it("checks, starts one npm helper, returns the active operation, then requests shutdown", async () => {
    const fixture = await npmFixture();
    const spawnUpdater = vi.fn(() => ({ pid: 777 }) as unknown as ChildProcess);
    const manager = createBackgroundUpdateManager({
      platform: "darwin",
      randomId: () => "one",
      spawnUpdater,
      now: () => 10_000,
    });
    const shutdown = vi.fn(async () => {});
    const coordinator = createHostUpdateCoordinator({
      hostRuntimePath: fixture.hostRuntimePath,
      environment: fixture.environment,
      platform: "darwin",
      architecture: "arm64",
      manager,
      fetchLatest: async () => release(),
      shutdown,
    });

    await expect(coordinator.check()).resolves.toMatchObject({
      currentVersion: "1.2.2",
      installation: "npm",
      latestVersion: "1.2.3",
      updateAvailable: true,
      installationAvailable: true,
    });
    await expect(coordinator.start()).resolves.toMatchObject({
      status: { version: "1.2.3", installation: "npm", phase: "prepared" },
    });
    await expect(coordinator.start()).resolves.toMatchObject({
      status: { version: "1.2.3", phase: "prepared" },
    });
    expect(spawnUpdater).toHaveBeenCalledOnce();

    coordinator.requestShutdown();
    await vi.waitFor(() =>
      expect(shutdown).toHaveBeenCalledWith({
        port: 43124,
        nonce: "0123456789abcdef0123456789abcdef",
      }),
    );
  });

  it("returns before a macOS artifact download completes and shuts down afterward", async () => {
    const fixture = await macFixture();
    const bytes = Buffer.from("macos-dmg-fixture");
    let unblockDownload!: () => void;
    let resolveDownloadObserved!: () => void;
    const downloadObserved = new Promise<void>((resolve) => {
      resolveDownloadObserved = resolve;
    });
    const manager = createBackgroundUpdateManager({
      platform: "darwin",
      randomId: () => "async-macos",
      spawnUpdater: () => ({ pid: 778 }) as unknown as ChildProcess,
      download: async (_source, destination, onProgress) => {
        resolveDownloadObserved();
        await onProgress?.({ downloadedBytes: 1, totalBytes: bytes.length });
        await new Promise<void>((resume) => {
          unblockDownload = resume;
        });
        await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
        await onProgress?.({ downloadedBytes: bytes.length, totalBytes: bytes.length });
        return { bytes: bytes.length, finalUrl: "https://downloads.example.test/final" };
      },
    });
    const shutdown = vi.fn(async () => {});
    const coordinator = createHostUpdateCoordinator({
      hostRuntimePath: fixture.hostRuntimePath,
      environment: fixture.environment,
      platform: "darwin",
      architecture: "arm64",
      manager,
      fetchLatest: async () => ({
        version: "1.2.3",
        releaseNotes: "Release 1.2.3",
        releaseNotesUrl: "https://github.com/BytePioneer-AI/codex-host/releases/tag/v1.2.3",
        assets: [
          {
            name: "codexhost-1.2.3-macos-arm64.dmg",
            size: bytes.length,
            digest: `sha256:${digest(bytes)}`,
            downloadUrl:
              "https://github.com/BytePioneer-AI/codex-host/releases/download/v1.2.3/codexhost-1.2.3-macos-arm64.dmg",
          },
        ],
      }),
      shutdown,
    });

    const result = await coordinator.start();
    expect(result.status).toMatchObject({ version: "1.2.3", installation: "macos-dmg" });
    await downloadObserved;
    coordinator.requestShutdown();
    expect(shutdown).not.toHaveBeenCalled();
    await vi.waitFor(async () =>
      expect((await coordinator.status()).status).toMatchObject({
        phase: "downloading",
        downloadedBytes: 1,
        totalBytes: bytes.length,
      }),
    );
    unblockDownload();
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());
  });

  it("ignores a prepared status without an active operation lock", async () => {
    const fixture = await npmFixture();
    const home = fixture.environment.HOME;
    if (!home) throw new Error("fixture HOME is missing");
    const stateDirectory = path.join(home, ".codexhost", "updates");
    await mkdir(path.join(stateDirectory, "update-stale"), { recursive: true });
    await writeFile(
      path.join(stateDirectory, "update-stale", "status-v1.json"),
      JSON.stringify({
        schemaVersion: 1,
        version: "1.2.3",
        installation: "npm",
        phase: "prepared",
        updatedAt: 20,
      }),
    );
    const coordinator = createHostUpdateCoordinator({
      hostRuntimePath: fixture.hostRuntimePath,
      environment: fixture.environment,
      platform: "darwin",
      architecture: "arm64",
      fetchLatest: async () => release(),
    });

    await expect(coordinator.check()).resolves.toMatchObject({ status: null });
  });

  it("starts a compatibility update without waiting for background preparation", async () => {
    let resolveStart: (() => void) | undefined;
    const start = vi.fn(
      () =>
        new Promise<never>(() => {
          resolveStart = () => undefined;
        }),
    );
    const check = vi.fn(async () => ({
      currentVersion: "1.2.2",
      installation: "npm" as const,
      latestVersion: "1.2.3",
      updateAvailable: true,
      installationAvailable: true,
      releaseNotes: null,
      releaseNotesUrl: null,
      status: null,
      error: null,
    }));

    await expect(startCompatibilityUpdate({ check, start })).resolves.toBe("update-started");
    expect(start).toHaveBeenCalledOnce();
    expect(resolveStart).toEqual(expect.any(Function));
  });

  it("keeps GitHub failures non-blocking and reports no same-version update", async () => {
    const fixture = await npmFixture();
    const failed = createHostUpdateCoordinator({
      hostRuntimePath: fixture.hostRuntimePath,
      environment: fixture.environment,
      platform: "darwin",
      architecture: "arm64",
      fetchLatest: async () => {
        throw new Error("GitHub unavailable");
      },
    });
    await expect(failed.check()).resolves.toMatchObject({
      currentVersion: "1.2.2",
      installation: "npm",
      latestVersion: null,
      updateAvailable: false,
      error: "GitHub unavailable",
    });

    const current = createHostUpdateCoordinator({
      hostRuntimePath: fixture.hostRuntimePath,
      environment: fixture.environment,
      platform: "darwin",
      architecture: "arm64",
      fetchLatest: async () => release("1.2.2"),
    });
    await expect(current.check()).resolves.toMatchObject({
      updateAvailable: false,
      installationAvailable: false,
      error: null,
    });
  });
});
