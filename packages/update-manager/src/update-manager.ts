import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  downloadArtifact,
  validateArtifact,
  verifyDownloadedArtifact,
  type ArtifactDownloadProgress,
  type ArtifactDownloader,
  type ArtifactSource,
} from "./artifact.js";
import {
  parseUpdateStatus,
  preparedStatus,
  requireSemanticVersion,
  type BackgroundUpdateInstallation,
  type BackgroundUpdateStatus,
} from "./status.js";

const REQUEST_SCHEMA_VERSION = 1;

export interface PreparedUpdateInfo {
  version: string;
  installation: BackgroundUpdateInstallation;
  statusPath: string;
}

export interface CommonUpdateOptions {
  version: string;
  launcherPid: number;
  launcherExecutable: string;
  updaterExecutable: string;
  stateDirectory: string;
  onPrepared?(info: PreparedUpdateInfo): void | Promise<void>;
}

export interface NpmUpdateOptions extends CommonUpdateOptions {
  nodePath: string;
  npmCliPath: string;
  npmLauncherPath: string;
  packageRoot: string;
}

export interface WindowsInstallerUpdateOptions extends CommonUpdateOptions {
  artifact: ArtifactSource;
  installRoot: string;
}

export interface MacOsDmgUpdateOptions extends CommonUpdateOptions {
  artifact: ArtifactSource;
  appPath: string;
}

export interface PreparedBackgroundUpdate {
  version: string;
  installation: BackgroundUpdateInstallation;
  requestPath: string;
  statusPath: string;
  helperPath: string;
  artifactPath?: string;
}

export interface StartedBackgroundUpdate extends PreparedBackgroundUpdate {
  updaterPid: number;
}

export interface BackgroundUpdateManagerDependencies {
  platform?: NodeJS.Platform;
  randomId?(): string;
  download?: ArtifactDownloader;
  spawnUpdater?(executable: string, requestPath: string): ChildProcess;
  now?(): number;
}

export interface BackgroundUpdateManager {
  prepareNpm(options: NpmUpdateOptions): Promise<PreparedBackgroundUpdate>;
  prepareWindowsInstaller(
    options: WindowsInstallerUpdateOptions,
  ): Promise<PreparedBackgroundUpdate>;
  prepareMacOsDmg(options: MacOsDmgUpdateOptions): Promise<PreparedBackgroundUpdate>;
  start(prepared: PreparedBackgroundUpdate): StartedBackgroundUpdate;
  readStatus(statusPath: string): Promise<BackgroundUpdateStatus | null>;
}

interface InternalRequest {
  schema_version: 1;
  version: string;
  wait_pid: number;
  wait_executable: string;
  status_path: string;
  installation:
    | {
        kind: "npm";
        node_path: string;
        npm_cli_path: string;
        npm_launcher_path: string;
      }
    | {
        kind: "windows-installer";
        installer_path: string;
        artifact_sha256: string;
        install_root: string;
      }
    | {
        kind: "macos-dmg";
        dmg_path: string;
        artifact_sha256: string;
        app_path: string;
      };
}

interface PreparedCommonUpdate {
  version: string;
  launcherPid: number;
  launcherExecutable: string;
  workDirectory: string;
  helperPath: string;
  requestPath: string;
  statusPath: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireAbsolutePath(value: string, label: string): string {
  if (!path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  return path.normalize(value);
}

async function requireRegularFile(value: string, label: string): Promise<string> {
  const filePath = requireAbsolutePath(value, label);
  const metadata = await lstat(filePath).catch((error) => {
    throw new Error(`${label} is unavailable: ${errorMessage(error)}`);
  });
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file`);
  }
  return filePath;
}

function requireLauncherPid(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Launcher PID must be a positive integer");
  }
  return value;
}

async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
}

function defaultSpawnUpdater(executable: string, requestPath: string): ChildProcess {
  const child = spawn(executable, ["apply", "--request", requestPath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return child;
}

export function createBackgroundUpdateManager(
  dependencies: BackgroundUpdateManagerDependencies = {},
): BackgroundUpdateManager {
  const platform = dependencies.platform ?? process.platform;
  const randomId = dependencies.randomId ?? randomUUID;
  const download = dependencies.download ?? downloadArtifact;
  const spawnUpdater = dependencies.spawnUpdater ?? defaultSpawnUpdater;
  const now = dependencies.now ?? Date.now;
  const preparedRequests = new Set<string>();

  async function writeStatusSnapshot(
    statusPath: string,
    status: BackgroundUpdateStatus,
  ): Promise<void> {
    const temporaryPath = path.join(path.dirname(statusPath), `.update-status-${randomId()}.tmp`);
    try {
      await writeFile(temporaryPath, `${JSON.stringify(status)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporaryPath, statusPath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  function statusSnapshot(
    version: string,
    installation: BackgroundUpdateInstallation,
    phase: BackgroundUpdateStatus["phase"],
    progress?: ArtifactDownloadProgress,
    error?: unknown,
  ): BackgroundUpdateStatus {
    return {
      schemaVersion: 1,
      version,
      installation,
      phase,
      updatedAt: Math.floor(now() / 1000),
      ...(progress?.downloadedBytes === undefined
        ? {}
        : { downloadedBytes: progress.downloadedBytes }),
      ...(progress?.totalBytes === undefined ? {} : { totalBytes: progress.totalBytes }),
      ...(error === undefined ? {} : { error: errorMessage(error).slice(0, 500) }),
    };
  }

  async function writeFailedStatus(
    statusPath: string,
    version: string,
    installation: BackgroundUpdateInstallation,
    error: unknown,
  ): Promise<void> {
    await writeStatusSnapshot(
      statusPath,
      statusSnapshot(version, installation, "failed", undefined, error),
    ).catch(() => undefined);
  }

  function progressReporter(
    statusPath: string,
    version: string,
    installation: BackgroundUpdateInstallation,
    totalBytes: number | undefined,
  ): { update(progress: ArtifactDownloadProgress): void; flush(): Promise<void> } {
    let lastProgress: ArtifactDownloadProgress = { downloadedBytes: 0, totalBytes };
    let lastWriteAt = 0;
    let queued = Promise.resolve();
    const enqueue = (progress: ArtifactDownloadProgress, force = false): void => {
      lastProgress = progress;
      const currentTime = Date.now();
      if (!force && currentTime - lastWriteAt < 250) return;
      lastWriteAt = currentTime;
      queued = queued
        .then(() =>
          writeStatusSnapshot(
            statusPath,
            statusSnapshot(version, installation, "downloading", lastProgress),
          ),
        )
        .catch(() => undefined);
    };
    enqueue(lastProgress, true);
    return {
      update(progress) {
        enqueue(progress);
      },
      async flush() {
        enqueue(lastProgress, true);
        await queued;
      },
    };
  }

  async function prepareCommon(
    options: CommonUpdateOptions,
    installation: BackgroundUpdateInstallation,
  ): Promise<PreparedCommonUpdate> {
    const version = requireSemanticVersion(options.version);
    const launcherPid = requireLauncherPid(options.launcherPid);
    const launcherExecutable = await requireRegularFile(
      options.launcherExecutable,
      "Launcher executable",
    );
    const updaterExecutable = await requireRegularFile(
      options.updaterExecutable,
      "Updater executable",
    );
    const stateDirectory = requireAbsolutePath(options.stateDirectory, "update state directory");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const workDirectory = path.join(stateDirectory, `update-${version}-${randomId()}`);
    await mkdir(workDirectory, { recursive: false, mode: 0o700 });
    const executableSuffix = platform === "win32" ? ".exe" : "";
    const helperPath = path.join(workDirectory, `codexhost-updater${executableSuffix}`);
    await copyFile(updaterExecutable, helperPath);
    if (platform !== "win32") await chmod(helperPath, 0o700);
    const requestPath = path.join(workDirectory, "request-v1.json");
    const statusPath = path.join(workDirectory, "status-v1.json");
    await writePrivateJson(statusPath, preparedStatus(version, installation, now()));
    await options.onPrepared?.({ version, installation, statusPath });
    return {
      version,
      launcherPid,
      launcherExecutable,
      workDirectory,
      helperPath,
      requestPath,
      statusPath,
    };
  }

  async function prepareArtifact(
    common: PreparedCommonUpdate,
    installation: BackgroundUpdateInstallation,
    sourceValue: ArtifactSource,
    fileName: string,
  ): Promise<{ source: ArtifactSource; artifactPath: string }> {
    const source = validateArtifact(sourceValue);
    const temporaryPath = path.join(common.workDirectory, `.${fileName}.download`);
    const artifactPath = path.join(common.workDirectory, fileName);
    const progress = progressReporter(common.statusPath, common.version, installation, source.size);
    try {
      const result = await download(source, temporaryPath, progress.update);
      progress.update({ downloadedBytes: result.bytes, totalBytes: source.size });
      await progress.flush();
      const finalUrl = new URL(result.finalUrl);
      if (finalUrl.protocol !== "https:" || finalUrl.username || finalUrl.password) {
        throw new Error("update artifact downloader returned a non-HTTPS URL");
      }
      await verifyDownloadedArtifact(source, temporaryPath, result);
      await rename(temporaryPath, artifactPath);
      return { source, artifactPath };
    } catch (error) {
      await rm(temporaryPath, { force: true });
      await progress.flush();
      await writeFailedStatus(common.statusPath, common.version, installation, error);
      throw error;
    }
  }

  async function finalize(
    common: PreparedCommonUpdate,
    installation: InternalRequest["installation"],
    artifactPath?: string,
  ): Promise<PreparedBackgroundUpdate> {
    const request: InternalRequest = {
      schema_version: REQUEST_SCHEMA_VERSION,
      version: common.version,
      wait_pid: common.launcherPid,
      wait_executable: common.launcherExecutable,
      status_path: common.statusPath,
      installation,
    };
    await writePrivateJson(common.requestPath, request);
    await writeStatusSnapshot(
      common.statusPath,
      statusSnapshot(common.version, installation.kind, "prepared"),
    );
    preparedRequests.add(common.requestPath);
    return Object.freeze({
      version: common.version,
      installation: installation.kind,
      requestPath: common.requestPath,
      statusPath: common.statusPath,
      helperPath: common.helperPath,
      ...(artifactPath === undefined ? {} : { artifactPath }),
    });
  }

  return Object.freeze({
    async prepareNpm(options: NpmUpdateOptions): Promise<PreparedBackgroundUpdate> {
      const common = await prepareCommon(options, "npm");
      try {
        return await finalize(common, {
          kind: "npm",
          node_path: await requireRegularFile(options.nodePath, "npm Node.js executable"),
          npm_cli_path: await requireRegularFile(options.npmCliPath, "npm CLI"),
          npm_launcher_path: await requireRegularFile(
            options.npmLauncherPath,
            "npm codexhost launcher",
          ),
        });
      } catch (error) {
        await writeFailedStatus(common.statusPath, common.version, "npm", error);
        throw error;
      }
    },

    async prepareWindowsInstaller(
      options: WindowsInstallerUpdateOptions,
    ): Promise<PreparedBackgroundUpdate> {
      if (platform !== "win32") throw new Error("Windows installer updates require Windows");
      const common = await prepareCommon(options, "windows-installer");
      const artifact = await prepareArtifact(
        common,
        "windows-installer",
        options.artifact,
        "update.exe",
      );
      return finalize(
        common,
        {
          kind: "windows-installer",
          installer_path: artifact.artifactPath,
          artifact_sha256: artifact.source.sha256,
          install_root: requireAbsolutePath(options.installRoot, "Windows install root"),
        },
        artifact.artifactPath,
      );
    },

    async prepareMacOsDmg(options: MacOsDmgUpdateOptions): Promise<PreparedBackgroundUpdate> {
      if (platform !== "darwin") throw new Error("macOS DMG updates require macOS");
      const common = await prepareCommon(options, "macos-dmg");
      const appPath = requireAbsolutePath(options.appPath, "macOS application path");
      if (path.extname(appPath) !== ".app") {
        throw new Error("macOS application path must end in .app");
      }
      const artifact = await prepareArtifact(common, "macos-dmg", options.artifact, "update.dmg");
      return finalize(
        common,
        {
          kind: "macos-dmg",
          dmg_path: artifact.artifactPath,
          artifact_sha256: artifact.source.sha256,
          app_path: appPath,
        },
        artifact.artifactPath,
      );
    },

    start(prepared: PreparedBackgroundUpdate): StartedBackgroundUpdate {
      if (!preparedRequests.delete(prepared.requestPath)) {
        throw new Error(
          "background update was not prepared by this manager or was already started",
        );
      }
      const child = spawnUpdater(prepared.helperPath, prepared.requestPath);
      if (child.pid === undefined)
        throw new Error("background Updater did not report a process ID");
      return Object.freeze({ ...prepared, updaterPid: child.pid });
    },

    async readStatus(statusPathValue: string): Promise<BackgroundUpdateStatus | null> {
      const statusPath = requireAbsolutePath(statusPathValue, "update status path");
      try {
        return parseUpdateStatus(JSON.parse(await readFile(statusPath, "utf8")));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
  });
}
