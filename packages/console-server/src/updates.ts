import path from "node:path";

import type {
  UpdateCheckResult,
  UpdateStartResult,
  UpdateStatus,
  UpdateStatusResult,
} from "@codexhost/shared-contracts";
import {
  acquireUpdateOperationLock,
  cleanupTerminalUpdateState,
  compareSemanticVersions,
  createBackgroundUpdateManager,
  defaultUpdateStateDirectory,
  discoverLatestUpdateStatus,
  fetchLatestGitHubRelease,
  fetchLatestGitHubReleaseWithGitHubCli,
  isUpdateOperationActive,
  recoverUpdateOperationLock,
  selectInstallerReleaseArtifact,
  type BackgroundUpdateManager,
  type BackgroundUpdateStatus,
  type CodexhostLatestRelease,
  type CommonUpdateOptions,
  type DistributionMetadata,
  type InstallerReleaseTarget,
  type PreparedBackgroundUpdate,
} from "@codexhost/update-manager";

const ERROR_MAX_LENGTH = 500;

export class ConsoleUpdateError extends Error {
  constructor(
    readonly code: "codex-running" | "unsupported" | "busy" | "stale" | "failed",
    message: string,
  ) {
    super(message);
    this.name = "ConsoleUpdateError";
  }
}

/** What the console knows about the installation at the time of the request. */
export interface ConsoleUpdateTarget {
  distribution: DistributionMetadata | null;
  appDirectory: string;
  /** Launcher runtime descriptor path from `inspect --json`. */
  runtimeDescriptorPath: string | null;
  codexhostRunning: boolean;
}

export interface ConsoleUpdates {
  check(target: ConsoleUpdateTarget, signal?: AbortSignal): Promise<UpdateCheckResult>;
  start(target: ConsoleUpdateTarget): Promise<UpdateStartResult>;
  status(): Promise<UpdateStatusResult>;
}

export interface CreateConsoleUpdatesOptions {
  /** Called once the Updater owns the update; the console must then exit. */
  onHandedOff(): void;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Process the Updater waits on before installing: this console. */
  processId?: number;
  processExecutable?: string;
  stateDirectory?: string;
  manager?: BackgroundUpdateManager;
  fetchLatest?(signal?: AbortSignal): Promise<CodexhostLatestRelease>;
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, ERROR_MAX_LENGTH) || "Update operation failed";
}

function publicStatus(status: BackgroundUpdateStatus): UpdateStatus {
  return {
    version: status.version,
    installation: status.installation,
    phase: status.phase,
    updatedAt: status.updatedAt,
    ...(status.downloadedBytes === undefined ? {} : { downloadedBytes: status.downloadedBytes }),
    ...(status.totalBytes === undefined ? {} : { totalBytes: status.totalBytes }),
    error: status.error?.slice(0, ERROR_MAX_LENGTH) ?? null,
  };
}

function installationKind(
  metadata: DistributionMetadata,
): "npm" | "windows-installer" | "macos-dmg" | null {
  if (metadata.distribution === "npm") return "npm";
  if (metadata.target.startsWith("windows-")) return "windows-installer";
  if (metadata.target.startsWith("macos-")) return "macos-dmg";
  return null;
}

function absoluteEnvironmentPath(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value || !path.isAbsolute(value)) {
    throw new ConsoleUpdateError(
      "unsupported",
      `${name} is unavailable; run 'codexhost console' from the npm command to update`,
    );
  }
  return path.normalize(value);
}

export function createConsoleUpdates(options: CreateConsoleUpdatesOptions): ConsoleUpdates {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const manager = options.manager ?? createBackgroundUpdateManager({ platform });
  const stateDirectory = (): string =>
    options.stateDirectory ?? defaultUpdateStateDirectory(platform, environment);
  const fetchLatest =
    options.fetchLatest ??
    (async (signal?: AbortSignal): Promise<CodexhostLatestRelease> => {
      const timeoutSignal = AbortSignal.timeout(15_000);
      const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      const authenticated = await fetchLatestGitHubReleaseWithGitHubCli({
        environment,
        platform,
        signal: requestSignal,
      });
      return authenticated ?? fetchLatestGitHubRelease({ signal: requestSignal });
    });
  let candidate: CodexhostLatestRelease | null = null;
  let handedOff = false;

  async function latestStatus(): Promise<UpdateStatus | null> {
    const directory = stateDirectory();
    const discovered = await discoverLatestUpdateStatus(directory);
    if (!discovered) return null;
    if (
      discovered.status.phase !== "succeeded" &&
      discovered.status.phase !== "failed" &&
      !(await isUpdateOperationActive(directory))
    ) {
      return null;
    }
    return publicStatus(discovered.status);
  }

  function installable(metadata: DistributionMetadata, release: CodexhostLatestRelease): boolean {
    const kind = installationKind(metadata);
    if (kind === "npm") return true;
    if (kind === null) return false;
    try {
      selectInstallerReleaseArtifact(release, metadata.target as InstallerReleaseTarget);
      return true;
    } catch {
      return false;
    }
  }

  async function prepare(
    metadata: DistributionMetadata,
    target: ConsoleUpdateTarget,
    release: CodexhostLatestRelease,
    onPrepared: NonNullable<CommonUpdateOptions["onPrepared"]>,
  ): Promise<PreparedBackgroundUpdate> {
    const resourcesRoot = path.dirname(target.appDirectory);
    const common: CommonUpdateOptions = {
      version: release.version,
      launcherPid: options.processId ?? process.pid,
      launcherExecutable: options.processExecutable ?? process.execPath,
      runtimeDescriptorPath: target.runtimeDescriptorPath as string,
      updaterExecutable: path.join(
        resourcesRoot,
        "libexec",
        platform === "win32" ? "codexhost-updater.exe" : "codexhost-updater",
      ),
      stateDirectory: stateDirectory(),
      onPrepared,
    };
    const kind = installationKind(metadata);
    if (kind === "npm") {
      const packageRoot = absoluteEnvironmentPath(environment, "CODEXHOST_NPM_PACKAGE_ROOT");
      if (packageRoot !== resourcesRoot) {
        throw new ConsoleUpdateError(
          "unsupported",
          "npm platform package root does not own this console",
        );
      }
      return manager.prepareNpm({
        ...common,
        packageRoot,
        nodePath: absoluteEnvironmentPath(environment, "CODEXHOST_NPM_NODE_PATH"),
        npmCliPath: absoluteEnvironmentPath(environment, "CODEXHOST_NPM_CLI_PATH"),
        npmLauncherPath: absoluteEnvironmentPath(environment, "CODEXHOST_NPM_LAUNCHER_PATH"),
      });
    }
    if (kind === null) {
      throw new ConsoleUpdateError("unsupported", "Linux installer updates are unsupported");
    }
    const artifact = selectInstallerReleaseArtifact(
      release,
      metadata.target as InstallerReleaseTarget,
    ).source;
    if (kind === "windows-installer") {
      return manager.prepareWindowsInstaller({ ...common, artifact, installRoot: resourcesRoot });
    }
    // Contents/Resources/app → the .app bundle.
    const appPath = path.dirname(path.dirname(resourcesRoot));
    return manager.prepareMacOsDmg({ ...common, artifact, appPath });
  }

  return Object.freeze({
    async check(target: ConsoleUpdateTarget, signal?: AbortSignal): Promise<UpdateCheckResult> {
      const metadata = target.distribution;
      const empty: UpdateCheckResult = {
        currentVersion: metadata?.version ?? "0.0.0",
        installation: metadata ? installationKind(metadata) : null,
        latestVersion: null,
        updateAvailable: false,
        installationAvailable: false,
        releaseNotes: null,
        releaseNotesUrl: null,
        status: null,
        error: null,
      };
      if (!metadata) {
        return { ...empty, error: "This codexhost is a source checkout without release metadata" };
      }
      let status: UpdateStatus | null = null;
      try {
        await recoverUpdateOperationLock(stateDirectory());
        await cleanupTerminalUpdateState(stateDirectory());
        status = await latestStatus();
        const release = await fetchLatest(signal);
        candidate = release;
        const updateAvailable = compareSemanticVersions(metadata.version, release.version) < 0;
        const installationAvailable = updateAvailable && installable(metadata, release);
        return {
          ...empty,
          latestVersion: release.version,
          updateAvailable,
          installationAvailable,
          releaseNotes: release.releaseNotes,
          releaseNotesUrl: release.releaseNotesUrl,
          status,
          error:
            updateAvailable && !installationAvailable
              ? "The latest GitHub Release has no verified asset for this installation"
              : null,
        };
      } catch (error) {
        return { ...empty, status, error: boundedError(error) };
      }
    },

    async start(target: ConsoleUpdateTarget): Promise<UpdateStartResult> {
      if (target.codexhostRunning) {
        throw new ConsoleUpdateError(
          "codex-running",
          "codexhost is running; update from Codex settings or quit Codex Desktop first",
        );
      }
      const metadata = target.distribution;
      if (!metadata) {
        throw new ConsoleUpdateError("unsupported", "A source checkout cannot update itself");
      }
      if (!target.runtimeDescriptorPath || !path.isAbsolute(target.runtimeDescriptorPath)) {
        throw new ConsoleUpdateError("unsupported", "The Launcher runtime path is unavailable");
      }
      if (handedOff) {
        const existing = await latestStatus();
        if (existing) return { status: existing };
      }
      const directory = stateDirectory();
      await recoverUpdateOperationLock(directory);
      const lock = await acquireUpdateOperationLock(directory);
      if (!lock) {
        const existing = await latestStatus();
        if (existing) return { status: existing };
        throw new ConsoleUpdateError("busy", "Another update operation is already active");
      }
      try {
        const release = await fetchLatest();
        if (
          compareSemanticVersions(metadata.version, release.version) >= 0 ||
          (candidate && candidate.version !== release.version)
        ) {
          throw new ConsoleUpdateError(
            "stale",
            "The selected update is no longer the current GitHub Release",
          );
        }
        let resolvePrepared!: (statusPath: string) => void;
        let rejectPrepared!: (error: unknown) => void;
        const preparedReady = new Promise<string>((resolve, reject) => {
          resolvePrepared = resolve;
          rejectPrepared = reject;
        });
        const run = async (): Promise<void> => {
          try {
            const prepared = await prepare(metadata, target, release, async (info) => {
              await lock.setStatusPath(info.statusPath);
              resolvePrepared(info.statusPath);
            });
            // The console runs outside the Codex Desktop process tree on every
            // platform, so it starts the Updater itself and then exits so the
            // Updater's wait on this process completes.
            manager.start(prepared);
            handedOff = true;
            options.onHandedOff();
          } catch (error) {
            await lock.release();
            rejectPrepared(error);
          }
        };
        void run();
        const statusPath = await preparedReady;
        const status = await manager.readStatus(statusPath);
        if (!status) throw new Error("Background update did not create status");
        return { status: publicStatus(status) };
      } catch (error) {
        await lock.release();
        throw error;
      }
    },

    async status(): Promise<UpdateStatusResult> {
      try {
        await recoverUpdateOperationLock(stateDirectory());
        return { status: await latestStatus() };
      } catch {
        return { status: null };
      }
    },
  });
}
