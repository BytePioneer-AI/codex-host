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
  discoverLatestUpdateStatus,
  fetchLatestGitHubRelease,
  isUpdateOperationActive,
  recoverUpdateOperationLock,
  resolveInstalledUpdateContext,
  selectInstallerReleaseArtifact,
  type BackgroundUpdateManager,
  type BackgroundUpdateStatus,
  type CodexhostLatestRelease,
  type InstalledUpdateContext,
} from "@codexhost/update-manager";

const ERROR_MAX_LENGTH = 500;

export interface HostUpdateCoordinator {
  check(signal?: AbortSignal): Promise<UpdateCheckResult>;
  start(): Promise<UpdateStartResult>;
  status(): Promise<UpdateStatusResult>;
}

export interface CreateHostUpdateCoordinatorOptions {
  hostRuntimePath: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  architecture?: string;
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

export function createHostUpdateCoordinator(
  options: CreateHostUpdateCoordinatorOptions,
): HostUpdateCoordinator {
  const platform = options.platform ?? process.platform;
  const manager = options.manager ?? createBackgroundUpdateManager({ platform });
  let contextPromise: Promise<InstalledUpdateContext> | undefined;
  const installedContext = (): Promise<InstalledUpdateContext> => {
    contextPromise ??= resolveInstalledUpdateContext({
      hostRuntimePath: options.hostRuntimePath,
      ...(options.environment ? { environment: options.environment } : {}),
      ...(options.platform ? { platform: options.platform } : {}),
      ...(options.architecture ? { architecture: options.architecture } : {}),
    });
    return contextPromise;
  };
  const fetchLatest: (signal?: AbortSignal) => Promise<CodexhostLatestRelease> =
    options.fetchLatest ??
    ((signal?: AbortSignal) =>
      fetchLatestGitHubRelease({ signal: signal ?? AbortSignal.timeout(15_000) }));
  let candidate: CodexhostLatestRelease | null = null;

  async function latestStatus(context: InstalledUpdateContext): Promise<UpdateStatus | null> {
    const discovered = await discoverLatestUpdateStatus(context.common.stateDirectory);
    if (!discovered) return null;
    if (
      discovered.status.phase !== "succeeded" &&
      discovered.status.phase !== "failed" &&
      !(await isUpdateOperationActive(context.common.stateDirectory))
    ) {
      return null;
    }
    return publicStatus(discovered.status);
  }

  async function installable(
    context: InstalledUpdateContext,
    release: CodexhostLatestRelease,
  ): Promise<boolean> {
    if (context.installation.kind === "npm") return true;
    const target = context.metadata.target;
    if (target === "linux-x64" || target === "linux-arm64") return false;
    try {
      selectInstallerReleaseArtifact(release, target);
      return true;
    } catch {
      return false;
    }
  }

  return Object.freeze({
    async check(signal?: AbortSignal): Promise<UpdateCheckResult> {
      let context: InstalledUpdateContext;
      try {
        context = await installedContext();
        await recoverUpdateOperationLock(context.common.stateDirectory);
        await cleanupTerminalUpdateState(context.common.stateDirectory);
      } catch (error) {
        return {
          currentVersion: "0.0.0",
          installation: null,
          latestVersion: null,
          updateAvailable: false,
          installationAvailable: false,
          releaseNotes: null,
          releaseNotesUrl: null,
          status: null,
          error: boundedError(error),
        };
      }
      const status = await latestStatus(context);
      try {
        const release = await fetchLatest(signal);
        candidate = release;
        const updateAvailable =
          compareSemanticVersions(context.metadata.version, release.version) < 0;
        let installationAvailable = false;
        let error: string | null = null;
        if (updateAvailable) {
          installationAvailable = await installable(context, release);
          if (!installationAvailable) {
            error = "The latest GitHub Release has no verified asset for this installation";
          }
        }
        return {
          currentVersion: context.metadata.version,
          installation: context.installation.kind,
          latestVersion: release.version,
          updateAvailable,
          installationAvailable,
          releaseNotes: release.releaseNotes,
          releaseNotesUrl: release.releaseNotesUrl,
          status,
          error,
        };
      } catch (error) {
        return {
          currentVersion: context.metadata.version,
          installation: context.installation.kind,
          latestVersion: null,
          updateAvailable: false,
          installationAvailable: false,
          releaseNotes: null,
          releaseNotesUrl: null,
          status,
          error: boundedError(error),
        };
      }
    },

    async start(): Promise<UpdateStartResult> {
      const context = await installedContext();
      await recoverUpdateOperationLock(context.common.stateDirectory);
      const lock = await acquireUpdateOperationLock(context.common.stateDirectory);
      if (!lock) {
        const existing = await latestStatus(context);
        if (existing) return { status: existing };
        throw new Error("Another update operation is already active");
      }

      let resolvePrepared!: (info: {
        version: string;
        installation: BackgroundUpdateStatus["installation"];
        statusPath: string;
      }) => void;
      let rejectPrepared!: (error: unknown) => void;
      const preparedReady = new Promise<{
        version: string;
        installation: BackgroundUpdateStatus["installation"];
        statusPath: string;
      }>((resolve, reject) => {
        resolvePrepared = resolve;
        rejectPrepared = reject;
      });

      try {
        const release = await fetchLatest();
        if (
          compareSemanticVersions(context.metadata.version, release.version) >= 0 ||
          (candidate && candidate.version !== release.version)
        ) {
          throw new Error("The selected update is no longer the current GitHub Release");
        }
        const onPrepared = async (info: {
          version: string;
          installation: BackgroundUpdateStatus["installation"];
          statusPath: string;
        }): Promise<void> => {
          await lock.setStatusPath(info.statusPath);
          resolvePrepared(info);
        };
        const prepareAndStart = async (): Promise<void> => {
          try {
            let prepared;
            if (context.installation.kind === "npm") {
              prepared = await manager.prepareNpm({
                ...context.installation.options,
                version: release.version,
                onPrepared,
              });
            } else {
              const target = context.metadata.target;
              if (target === "linux-x64" || target === "linux-arm64") {
                throw new Error("Linux installer updates are unsupported");
              }
              const artifact = selectInstallerReleaseArtifact(release, target).source;
              prepared =
                context.installation.kind === "windows-installer"
                  ? await manager.prepareWindowsInstaller({
                      ...context.installation.options,
                      version: release.version,
                      artifact,
                      onPrepared,
                    })
                  : await manager.prepareMacOsDmg({
                      ...context.installation.options,
                      version: release.version,
                      artifact,
                      onPrepared,
                    });
            }
            if (platform !== "darwin") manager.start(prepared);
          } catch (error) {
            await lock.release();
            rejectPrepared(error);
          }
        };
        void prepareAndStart();
        const prepared = await preparedReady;
        const status = await manager.readStatus(prepared.statusPath);
        if (!status) throw new Error("Background update did not create status");
        return { status: publicStatus(status) };
      } catch (error) {
        await lock.release();
        throw error;
      }
    },

    async status(): Promise<UpdateStatusResult> {
      try {
        const context = await installedContext();
        await recoverUpdateOperationLock(context.common.stateDirectory);
        return { status: await latestStatus(context) };
      } catch {
        return { status: null };
      }
    },
  });
}
