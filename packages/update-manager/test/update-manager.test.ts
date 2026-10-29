import { spawn, type ChildProcess } from "node:child_process";
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

import type { PrepareNpmMaterialsOptions, PreparedNpmMaterials } from "../src/npm-materials.js";
import { windowsInstallerFixture, windowsNpmFixture } from "./windows-fixture.js";

const roots: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-update-manager-"));
  roots.push(root);
  return root;
}

/** Fake Updaters stay alive like the real one; stop them before their files are removed. */
const updaters: ChildProcess[] = [];

function stopUpdater(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill();
  });
}

afterEach(async () => {
  renameFixture.attempts = 0;
  renameFixture.remainingFailures = 0;
  await Promise.all(updaters.splice(0).map(stopUpdater));
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

async function npmMaterials(options: PrepareNpmMaterialsOptions): Promise<PreparedNpmMaterials> {
  await mkdir(path.join(options.directory, "cache"), { recursive: true });
  const cli = path.join(options.directory, "cli.tgz");
  const platform = path.join(options.directory, "platform.tgz");
  const user = path.join(options.directory, "user.npmrc");
  const global = path.join(options.directory, "global.npmrc");
  await Promise.all([
    writeFile(cli, "CLI"),
    writeFile(platform, "platform"),
    writeFile(user, ""),
    writeFile(global, ""),
  ]);
  return {
    cli: { path: cli, sha256: sha256(Buffer.from("CLI")) },
    platform: { path: platform, sha256: sha256(Buffer.from("platform")) },
    unpacked_bytes: 1024,
    cache_path: path.join(options.directory, "cache"),
    user_config_path: user,
    global_config_path: global,
  };
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
      spawnUpdater: (executable, requestPath) => {
        const child = spawn(process.execPath, [
          "-e",
          `
          const fs = require("node:fs");
          const request = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
          const temporary = request.status_path + ".ready.tmp";
          // Match the real updater: readers see either complete status, never a truncated file,
          // and Windows sharing violations while the owner polls the status are retried.
          const handOff = (attempt) => {
            try {
              const status = JSON.parse(fs.readFileSync(request.status_path, "utf8"));
              fs.writeFileSync(temporary, JSON.stringify({ ...status, phase: "waiting-for-exit" }));
              fs.renameSync(temporary, request.status_path);
            } catch (error) {
              if (attempt >= 250 || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
              setTimeout(() => handOff(attempt + 1), 20);
            }
          };
          setTimeout(() => handOff(0), 150);
          // Like the real updater, stay alive after the handoff (it waits for the owner to exit).
          // The test stops it; a closed stdin means the test worker itself went away.
          process.stdin.on("end", () => process.exit(0));
          process.stdin.resume();
        `,
          executable,
          requestPath,
        ]);
        updaters.push(child);
        return child;
      },
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

    const started = await manager.start(prepared);
    expect(started.updaterPid).toBeTypeOf("number");
    await expect(manager.readStatus(prepared.statusPath)).resolves.toMatchObject({
      phase: "waiting-for-exit",
    });
    await expect(async () => manager.start(prepared)).rejects.toThrow("already started");
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

  it("records the Windows npm prefix and owner creation time and rejects an executable mismatch", async () => {
    const root = await temporaryDirectory();
    const installation = await windowsNpmFixture(root, true);
    const common = { ...(await commonOptions(root)), ...installation.paths };
    const prepareMaterials = vi.fn(npmMaterials);
    const spawnUpdater = vi.fn();
    const manager = createBackgroundUpdateManager({
      platform: "win32",
      architecture: "x64",
      prepareNpmMaterials: prepareMaterials,
      spawnUpdater,
      readProcessIdentity: async () => ({
        executable: installation.paths.launcherExecutable,
        startedAtMicros: "123456789",
      }),
    });
    await expect(manager.prepareNpm({ ...common, installedVersion: "1.2.1" })).rejects.toThrow(
      "does not match",
    );
    await expect(
      manager.prepareNpm({ ...common, installedVersion: "1.2.2", launcherStartedAtMicros: "999" }),
    ).rejects.toThrow("PID was reused");
    const prepared = await manager.prepareNpm({
      ...common,
      installedVersion: "1.2.2",
      launcherStartedAtMicros: "123456789",
    });
    const request = JSON.parse(await readFile(prepared.requestPath, "utf8"));
    expect(request.wait_started_at_micros).toBe("123456789");
    expect(prepareMaterials.mock.calls.map(([options]) => options.version)).toEqual([
      common.version,
      "1.2.2",
    ]);
    expect(request.installation.recovery.cli.path).toContain("npm-previous");
    const manifestPath = path.join(installation.paths.packageRoot, "package.json");
    const originalManifest = await readFile(manifestPath);
    await expect(manager.start(prepared)).resolves.not.toHaveProperty("updaterPid");
    expect(JSON.parse(await readFile(prepared.requestPath, "utf8"))).toHaveProperty(
      "launch_via_launcher",
      true,
    );
    expect(spawnUpdater).not.toHaveBeenCalled();
    expect((await manager.readStatus(prepared.statusPath))?.phase).toBe("prepared");
    expect(await readFile(manifestPath)).toEqual(originalManifest);
    expect(request.installation).toMatchObject({
      prefix: expect.stringContaining("中文 空格 prefix"),
      package_root: installation.paths.packageRoot,
      installed_version: "1.2.2",
    });
    const wrongOwner = createBackgroundUpdateManager({
      platform: "win32",
      architecture: "x64",
      readProcessIdentity: async () => ({
        executable: process.execPath,
        startedAtMicros: "987654321",
      }),
    });
    await expect(wrongOwner.prepareNpm(common)).rejects.toThrow(
      "does not match the process identity",
    );
  });

  it("keeps Windows npm unstartable until native package preparation completes and records preparation failures", async () => {
    const root = await temporaryDirectory();
    const installation = await windowsNpmFixture(root);
    const common = { ...(await commonOptions(root)), ...installation.paths };
    let reject!: (error: Error) => void;
    let statusPath = "";
    const spawnUpdater = vi.fn();
    const manager = createBackgroundUpdateManager({
      platform: "win32",
      architecture: "x64",
      spawnUpdater,
      readProcessIdentity: async () => ({
        executable: installation.paths.launcherExecutable,
        startedAtMicros: "123456789",
      }),
      prepareNpmMaterials: async () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    });
    const preparing = manager.prepareNpm({
      ...common,
      onPrepared: (info) => {
        statusPath = info.statusPath;
      },
    });
    await vi.waitFor(() => expect(reject).toBeTypeOf("function"));
    expect((await manager.readStatus(statusPath))?.phase).toBe("downloading");
    await expect(
      readFile(path.join(path.dirname(statusPath), "request-v1.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(spawnUpdater).not.toHaveBeenCalled();
    const failure = expect(preparing).rejects.toThrow("missing platform package");
    reject(new Error("missing platform package"));
    await failure;
    expect((await manager.readStatus(statusPath))?.phase).toBe("failed");
    expect(spawnUpdater).not.toHaveBeenCalled();
    await expect(
      manager.prepareNpm({ ...common, stateDirectory: path.join(installation.prefix, "updates") }),
    ).rejects.toThrow("outside");
    await expect(readFile(path.join(installation.prefix, "updates"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails before handoff if the original npm version cannot be prepared", async () => {
    const root = await temporaryDirectory();
    const installation = await windowsNpmFixture(root);
    const common = { ...(await commonOptions(root)), ...installation.paths };
    let statusPath = "";
    const spawnUpdater = vi.fn();
    const manager = createBackgroundUpdateManager({
      platform: "win32",
      architecture: "x64",
      spawnUpdater,
      readProcessIdentity: async () => ({
        executable: installation.paths.launcherExecutable,
        startedAtMicros: "123456789",
      }),
      prepareNpmMaterials: async (options) => {
        if (options.version === "1.2.2") throw new Error("original npm materials unavailable");
        return npmMaterials(options);
      },
    });
    await expect(
      manager.prepareNpm({
        ...common,
        onPrepared: (info) => {
          statusPath = info.statusPath;
        },
      }),
    ).rejects.toThrow("original npm materials unavailable");
    expect((await manager.readStatus(statusPath))?.phase).toBe("failed");
    expect(spawnUpdater).not.toHaveBeenCalled();
    await expect(
      readFile(path.join(path.dirname(statusPath), "request-v1.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

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

  it("rejects an installer without original-channel capability before downloading or creating a request", async () => {
    const root = await temporaryDirectory();
    const bytes = Buffer.from("signed-or-reviewed-inno-installer");
    const installation = await windowsInstallerFixture(root);
    const spawnUpdater = vi.fn();
    const manager = createBackgroundUpdateManager({
      platform: "win32",
      spawnUpdater,
      randomId: () => "windows-fixture",
      architecture: "x64",
      readProcessIdentity: async () => ({
        executable: installation.launcherExecutable,
        startedAtMicros: "123456789",
      }),
      download: downloader(bytes),
    });
    await expect(
      manager.prepareWindowsInstaller({
        ...(await commonOptions(root)),
        launcherExecutable: installation.launcherExecutable,
        artifact: {
          url: "https://downloads.example.test/codexhost.exe",
          sha256: sha256(bytes),
          size: bytes.length,
        },
        installRoot: installation.installRoot,
      }),
    ).rejects.toThrow("original directory");
    expect(spawnUpdater).not.toHaveBeenCalled();
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
    const installation = await windowsInstallerFixture(root);
    await writeFile(
      path.join(installation.installRoot, "app/codexhost-inno-files-v1.txt"),
      `codexhost-inno-files-v1\n1.2.2\nwindows-x64\n${["app/codexhost-distribution.json", "app/host-runtime.mjs", "bin/codexhost.exe", "runtime/node.exe", "libexec/codexhost-updater.exe"].map((p) => `${"ab".repeat(32)} 1 ${p}`).join("\n")}\n`,
    );
    const windows = createBackgroundUpdateManager({
      platform: "win32",
      architecture: "x64",
      readProcessIdentity: async () => ({
        executable: installation.launcherExecutable,
        startedAtMicros: "123456789",
      }),
      download: downloader(bytes),
    });
    await expect(
      windows.prepareWindowsInstaller({
        ...common,
        launcherExecutable: installation.launcherExecutable,
        artifact: {
          url: "https://downloads.example.test/codexhost.exe",
          sha256: "00".repeat(32),
        },
        installRoot: installation.installRoot,
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
