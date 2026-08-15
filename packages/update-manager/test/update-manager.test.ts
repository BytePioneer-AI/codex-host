import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { PathLike } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const renameFixture = vi.hoisted(() => ({
  attempts: 0,
  remainingFailures: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    async rename(oldPath: PathLike, newPath: PathLike): Promise<void> {
      if (String(newPath).endsWith("status-v1.json")) {
        renameFixture.attempts += 1;
        if (renameFixture.remainingFailures > 0) {
          renameFixture.remainingFailures -= 1;
          const error = new Error("status file is temporarily busy") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        }
      }
      await actual.rename(oldPath, newPath);
    },
  };
});

import {
  createBackgroundUpdateManager,
  discoverLatestUpdateStatus,
  type CommonUpdateOptions,
} from "../src/index.js";

const roots: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-update-manager-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  renameFixture.attempts = 0;
  renameFixture.remainingFailures = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function commonOptions(root: string): Promise<CommonUpdateOptions> {
  const files = {
    launcherExecutable: path.join(root, "installed", "bin", "codexhost"),
    updaterExecutable: path.join(root, "installed", "libexec", "codexhost-updater"),
  };
  for (const filePath of Object.values(files)) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "fixture\n", { mode: 0o700 });
  }
  return {
    version: "1.2.3-test.4",
    launcherPid: 4321,
    ...files,
    runtimeDescriptorPath: path.join(root, "runtime", "desktop-runtime-v1.json"),
    stateDirectory: path.join(root, "state"),
  };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function downloader(bytes: Buffer) {
  return async (_source: { url: string }, destination: string) => {
    await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
    return { bytes: bytes.length, finalUrl: "https://downloads.example.test/final" };
  };
}

describe("background update manager", () => {
  it("prepares and starts an exact npm update request", async () => {
    const root = await temporaryDirectory();
    const common = await commonOptions(root);
    const npmFiles = {
      nodePath: path.join(root, "node", "node"),
      npmCliPath: path.join(root, "node", "npm-cli.js"),
      npmLauncherPath: path.join(root, "npm", "bin", "codexhost.js"),
    };
    for (const filePath of Object.values(npmFiles)) {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "fixture\n");
    }
    const manager = createBackgroundUpdateManager({
      platform: "darwin",
      randomId: () => "npm-fixture",
      now: () => 1_700_000_000_000,
      spawnUpdater: (executable, requestPath) =>
        spawn(process.execPath, ["-e", "process.exit(0)", executable, requestPath]),
    });

    const prepared = await manager.prepareNpm({
      ...common,
      ...npmFiles,
      packageRoot: path.join(root, "npm", "platform-package"),
    });
    expect(prepared).toMatchObject({
      version: "1.2.3-test.4",
      installation: "npm",
    });
    expect(prepared.artifactPath).toBeUndefined();
    const request = JSON.parse(await readFile(prepared.requestPath, "utf8"));
    expect(request).toEqual({
      schema_version: 1,
      version: "1.2.3-test.4",
      wait_pid: 4321,
      wait_executable: common.launcherExecutable,
      runtime_descriptor_path: common.runtimeDescriptorPath,
      status_path: prepared.statusPath,
      installation: {
        kind: "npm",
        node_path: npmFiles.nodePath,
        npm_cli_path: npmFiles.npmCliPath,
        npm_launcher_path: npmFiles.npmLauncherPath,
      },
    });
    await expect(manager.readStatus(prepared.statusPath)).resolves.toEqual({
      schemaVersion: 1,
      version: "1.2.3-test.4",
      installation: "npm",
      phase: "prepared",
      updatedAt: 1_700_000_000,
    });

    const started = manager.start(prepared);
    expect(started.updaterPid).toBeTypeOf("number");
    expect(() => manager.start(prepared)).toThrow("already started");
  });

  it.skipIf(process.platform !== "win32")(
    "retries transient Windows status replacement failures",
    async () => {
      const root = await temporaryDirectory();
      const common = await commonOptions(root);
      const npmFiles = {
        nodePath: path.join(root, "node", "node"),
        npmCliPath: path.join(root, "node", "npm-cli.js"),
        npmLauncherPath: path.join(root, "npm", "bin", "codexhost.js"),
      };
      for (const filePath of Object.values(npmFiles)) {
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, "fixture\n");
      }
      renameFixture.remainingFailures = 2;
      const manager = createBackgroundUpdateManager({
        platform: "darwin",
        randomId: () => "retry-fixture",
      });

      await expect(
        manager.prepareNpm({
          ...common,
          ...npmFiles,
          packageRoot: path.join(root, "npm", "platform-package"),
        }),
      ).resolves.toMatchObject({ installation: "npm" });
      expect(renameFixture.attempts).toBe(3);
    },
  );

  it("reports artifact download progress while preparing an installer", async () => {
    const root = await temporaryDirectory();
    const bytes = Buffer.from("progress-artifact");
    const progress: Array<{ downloadedBytes: number; totalBytes: number | undefined }> = [];
    const manager = createBackgroundUpdateManager({
      platform: "darwin",
      randomId: () => "progress-fixture",
      download: async (_source, destination, onProgress) => {
        const first = { downloadedBytes: 4, totalBytes: bytes.length };
        const last = { downloadedBytes: bytes.length, totalBytes: bytes.length };
        if (!onProgress) throw new Error("download progress callback is missing");
        await onProgress(first);
        await onProgress(last);
        progress.push(first, last);
        await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
        return { bytes: bytes.length, finalUrl: "https://downloads.example.test/final" };
      },
    });
    const prepared = await manager.prepareMacOsDmg({
      ...(await commonOptions(root)),
      artifact: {
        url: "https://downloads.example.test/codexhost.dmg",
        sha256: sha256(bytes),
        size: bytes.length,
      },
      appPath: path.join(root, "Applications", "codexhost.app"),
      onPrepared: () => undefined,
    });
    expect(prepared.installation).toBe("macos-dmg");
    expect(progress).toEqual([
      { downloadedBytes: 4, totalBytes: bytes.length },
      { downloadedBytes: bytes.length, totalBytes: bytes.length },
    ]);
  });

  it("downloads and verifies the Windows installer before creating a request", async () => {
    const root = await temporaryDirectory();
    const bytes = Buffer.from("signed-or-reviewed-inno-installer");
    const manager = createBackgroundUpdateManager({
      platform: "win32",
      randomId: () => "windows-fixture",
      download: downloader(bytes),
    });
    const prepared = await manager.prepareWindowsInstaller({
      ...(await commonOptions(root)),
      artifact: {
        url: "https://downloads.example.test/codexhost.exe",
        sha256: sha256(bytes),
        size: bytes.length,
      },
      installRoot: path.join(root, "Programs", "codexhost"),
    });

    const artifactPath = prepared.artifactPath;
    expect(artifactPath).toBeDefined();
    if (artifactPath === undefined) throw new Error("Windows artifact path is missing");
    expect(await readFile(artifactPath)).toEqual(bytes);
    const request = JSON.parse(await readFile(prepared.requestPath, "utf8"));
    expect(request.installation).toEqual({
      kind: "windows-installer",
      installer_path: prepared.artifactPath,
      artifact_sha256: sha256(bytes),
      install_root: path.join(root, "Programs", "codexhost"),
    });
  });

  it("downloads and verifies the macOS DMG before creating a request", async () => {
    const root = await temporaryDirectory();
    const bytes = Buffer.from("ad-hoc-signed-dmg");
    const manager = createBackgroundUpdateManager({
      platform: "darwin",
      randomId: () => "macos-fixture",
      download: downloader(bytes),
    });
    const appPath = path.join(root, "Applications", "codexhost.app");
    const prepared = await manager.prepareMacOsDmg({
      ...(await commonOptions(root)),
      artifact: {
        url: "https://downloads.example.test/codexhost.dmg",
        sha256: sha256(bytes),
      },
      appPath,
    });

    const request = JSON.parse(await readFile(prepared.requestPath, "utf8"));
    expect(request.installation).toEqual({
      kind: "macos-dmg",
      dmg_path: prepared.artifactPath,
      artifact_sha256: sha256(bytes),
      app_path: appPath,
    });
  });

  it("rejects wrong platforms, insecure URLs, and mismatched artifacts", async () => {
    const root = await temporaryDirectory();
    const common = await commonOptions(root);
    const bytes = Buffer.from("different artifact");
    const windows = createBackgroundUpdateManager({
      platform: "win32",
      download: downloader(bytes),
    });
    await expect(
      windows.prepareWindowsInstaller({
        ...common,
        artifact: {
          url: "https://downloads.example.test/codexhost.exe",
          sha256: "00".repeat(32),
        },
        installRoot: path.join(root, "install"),
      }),
    ).rejects.toThrow("SHA-256 mismatch");

    const macos = createBackgroundUpdateManager({ platform: "darwin" });
    await expect(
      macos.prepareMacOsDmg({
        ...common,
        artifact: { url: "http://downloads.example.test/app.dmg", sha256: "00".repeat(32) },
        appPath: path.join(root, "codexhost.app"),
      }),
    ).rejects.toThrow("must use HTTPS");
    await expect(
      macos.prepareWindowsInstaller({
        ...common,
        artifact: { url: "https://example.test/app.exe", sha256: "00".repeat(32) },
        installRoot: path.join(root, "install"),
      }),
    ).rejects.toThrow("require Windows");
  });

  it("records installer preparation failures as terminal status", async () => {
    const root = await temporaryDirectory();
    const common = await commonOptions(root);
    const manager = createBackgroundUpdateManager({
      platform: "darwin",
      randomId: () => "failed-download",
      download: async () => {
        throw new Error("GitHub download failed");
      },
    });

    await expect(
      manager.prepareMacOsDmg({
        ...common,
        artifact: {
          url: "https://downloads.example.test/codexhost.dmg",
          sha256: "00".repeat(32),
          size: 10,
        },
        appPath: path.join(root, "Applications", "codexhost.app"),
      }),
    ).rejects.toThrow("GitHub download failed");
    await expect(discoverLatestUpdateStatus(common.stateDirectory)).resolves.toMatchObject({
      status: { phase: "failed", error: "GitHub download failed" },
    });
  });

  it("strictly validates persisted status", async () => {
    const root = await temporaryDirectory();
    const statusPath = path.join(root, "status.json");
    const manager = createBackgroundUpdateManager();
    await expect(manager.readStatus(statusPath)).resolves.toBeNull();
    await writeFile(
      statusPath,
      JSON.stringify({
        schemaVersion: 1,
        version: "1.2.3",
        installation: "npm",
        phase: "succeeded",
        updatedAt: 10,
        unexpected: true,
      }),
    );
    await expect(manager.readStatus(statusPath)).rejects.toThrow("unknown fields");
  });
});
