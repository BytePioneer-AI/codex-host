import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import {
  macosLocalSigningStatusSchema,
  type MacOsLocalSigningStatus,
  type UpdateBackgroundDownload,
  type UpdateBackgroundPhase,
  type UpdateCheckResult,
  type UpdateStartResult,
  type UpdateStatus,
  type UpdateStatusResult,
} from "@codexhost/shared-contracts";
import {
  acquireUpdateOperationLock,
  cleanupStagedUpdates,
  cleanupTerminalUpdateState,
  compareSemanticVersions,
  createBackgroundUpdateManager,
  createNpmReleaseAvailability,
  discoverActiveUpdateStatus,
  discoverRecentCompletedUpdateStatus,
  fetchLatestGitHubRelease,
  fetchLatestGitHubReleaseWithGitHubCli,
  fetchLatestNpmRelease,
  isUpdateOperationActive,
  readRuntimeMetadata,
  readStagedUpdate,
  recoverUpdateOperationLock,
  resolveInstalledUpdateContext,
  selectInstallerReleaseArtifact,
  verifyStagedArtifact,
  type BackgroundUpdateManager,
  type BackgroundUpdateStatus,
  type CodexhostLatestRelease,
  type InstalledUpdateContext,
  type NpmReleaseAvailability,
} from "@codexhost/update-manager";

const execFileAsync = promisify(execFile);
const ERROR_MAX_LENGTH = 500;
const UNSUPPORTED_MACOS_SIGNING_STATUS: MacOsLocalSigningStatus = Object.freeze({
  supported: false,
  enabled: false,
  certificatePresent: false,
  appSignedWithLocalCert: false,
  appPath: null,
  certificateName: "CodexHost Local Signer",
  certificateSha1: null,
});
const DEFAULT_BACKGROUND_INITIAL_DELAY_MS = 45_000;
const DEFAULT_BACKGROUND_INTERVAL_MS = 4 * 60 * 60 * 1000;
const DEFAULT_BACKGROUND_JITTER_MS = 5 * 60 * 1000;
const DEFAULT_BACKGROUND_RETRY_DELAYS_MS = [60_000, 5 * 60_000] as const;
const DEFAULT_BACKGROUND_MAX_AUTO_RETRIES = 2;

export interface HostUpdateBackgroundOptions {
  enabled?: boolean;
  initialDelayMs?: number;
  intervalMs?: number;
  jitterMs?: number;
  retryDelaysMs?: readonly number[];
  maxAutoRetries?: number;
}

export interface HostUpdateCoordinator {
  check(signal?: AbortSignal): Promise<UpdateCheckResult>;
  start(): Promise<UpdateStartResult>;
  status(): Promise<UpdateStatusResult>;
  macosSigning?(action: "status" | "setup" | "remove"): Promise<MacOsLocalSigningStatus>;
  dispose?(): void;
}

export interface CreateHostUpdateCoordinatorOptions {
  hostRuntimePath: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  architecture?: string;
  manager?: BackgroundUpdateManager;
  fetchLatest?(signal?: AbortSignal): Promise<CodexhostLatestRelease>;
  npmRelease?: NpmReleaseAvailability;
  runningTaskCount?(): number;
  background?: HostUpdateBackgroundOptions;
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
    ...(status.npmDownload === undefined ? {} : { npmDownload: status.npmDownload }),
    error: status.error?.slice(0, ERROR_MAX_LENGTH) ?? null,
    ...(status.serviceStopOutput === undefined
      ? {}
      : { serviceStopOutput: status.serviceStopOutput }),
  };
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as { unref?: () => void }).unref?.();
  }
}

export function createHostUpdateCoordinator(
  options: CreateHostUpdateCoordinatorOptions,
): HostUpdateCoordinator {
  const platform = options.platform ?? process.platform;
  const manager = options.manager ?? createBackgroundUpdateManager({ platform });
  const npmRelease = options.npmRelease ?? createNpmReleaseAvailability();
  const backgroundConfig = {
    enabled: options.background?.enabled ?? false,
    initialDelayMs: options.background?.initialDelayMs ?? DEFAULT_BACKGROUND_INITIAL_DELAY_MS,
    intervalMs: options.background?.intervalMs ?? DEFAULT_BACKGROUND_INTERVAL_MS,
    jitterMs: options.background?.jitterMs ?? DEFAULT_BACKGROUND_JITTER_MS,
    retryDelaysMs: options.background?.retryDelaysMs ?? DEFAULT_BACKGROUND_RETRY_DELAYS_MS,
    maxAutoRetries: options.background?.maxAutoRetries ?? DEFAULT_BACKGROUND_MAX_AUTO_RETRIES,
  };

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

  let lastEtag: string | null = null;
  let lastEtagRelease: CodexhostLatestRelease | null = null;

  const fetchLatest: (signal?: AbortSignal) => Promise<CodexhostLatestRelease> =
    options.fetchLatest ??
    (async (signal?: AbortSignal) => {
      const timeoutSignal = AbortSignal.timeout(15_000);
      const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      const authenticated = await fetchLatestGitHubReleaseWithGitHubCli({
        ...(options.environment ? { environment: options.environment } : {}),
        platform,
        signal: requestSignal,
      });
      if (authenticated) return authenticated;
      const fetched = await fetchLatestGitHubRelease({
        signal: requestSignal,
        ...(lastEtag && lastEtagRelease ? { etag: lastEtag, cachedRelease: lastEtagRelease } : {}),
        onEtag: (etag) => {
          lastEtag = etag;
        },
      });
      lastEtagRelease = fetched;
      return fetched;
    });

  /**
   * The stable version the npm registry advertises, when GitHub Release version
   * discovery is unavailable (e.g. anonymous API rate limiting). Only npm
   * installations can proceed without the Release; native ones still need it.
   */
  const npmFallbackRelease = async (
    context: InstalledUpdateContext,
    error: unknown,
    signal?: AbortSignal,
  ): Promise<CodexhostLatestRelease> => {
    if (signal?.aborted) throw error;
    if (context.installation.kind !== "npm") throw error;
    const npm = context.installation.options;
    const fallback = await fetchLatestNpmRelease(npm.nodePath, npm.npmCliPath);
    if (!fallback) throw error;
    return fallback;
  };

  let candidate: CodexhostLatestRelease | null = null;
  let currentStatusPath: string | null = null;

  // In-memory background staging state; never written into status-v1.json or active-update-v1.lock.
  let backgroundPhase: UpdateBackgroundPhase = "idle";
  let stagedVersion: string | null = null;
  let backgroundDownload: UpdateBackgroundDownload | null = null;
  let backgroundError: string | null = null;
  let backgroundTargetVersion: string | null = null;
  let retryState: { version: string; failures: number } | null = null;
  let activeStaging: { version: string; promise: Promise<void> } | null = null;

  let disposed = false;
  const backgroundAbort = new AbortController();
  let scheduleTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function currentRunningTaskCount(): number | undefined {
    if (!options.runningTaskCount) return undefined;
    const raw = options.runningTaskCount();
    return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
  }

  function clearTimers(): void {
    if (scheduleTimer !== null) {
      clearTimeout(scheduleTimer);
      scheduleTimer = null;
    }
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function resetBackgroundState(): void {
    backgroundPhase = "idle";
    stagedVersion = null;
    backgroundDownload = null;
    backgroundError = null;
    backgroundTargetVersion = null;
  }

  async function latestStatus(context: InstalledUpdateContext): Promise<UpdateStatus | null> {
    if (!currentStatusPath) {
      const active = await discoverActiveUpdateStatus(context.common.stateDirectory);
      if (!active) {
        const completed = await discoverRecentCompletedUpdateStatus(context.common.stateDirectory);
        return completed ? publicStatus(completed.status) : null;
      }
      currentStatusPath = active.statusPath;
    }
    const status = await manager.readStatus(currentStatusPath);
    return status ? publicStatus(status) : null;
  }

  /**
   * Whether this installation can install the release now. `error` is set when that cannot
   * be determined or never will be; `false` without an error means the release is not yet in
   * the npm registry this installation updates from, and is offered once it is.
   */
  async function installable(
    context: InstalledUpdateContext,
    release: CodexhostLatestRelease,
  ): Promise<{ available: boolean; error: string | null }> {
    if (context.installation.kind === "npm") {
      const npm = context.installation.options;
      try {
        const available = await npmRelease.installable({
          nodePath: npm.nodePath,
          npmCliPath: npm.npmCliPath,
          packageRoot: npm.packageRoot,
          version: release.version,
        });
        return { available, error: null };
      } catch (error) {
        return { available: false, error: boundedError(error) };
      }
    }
    try {
      selectInstallerReleaseArtifact(release, context.metadata.target);
      return { available: true, error: null };
    } catch {
      return {
        available: false,
        error: "The latest GitHub Release has no verified asset for this installation",
      };
    }
  }

  async function hasVerifiedStagedRelease(
    context: InstalledUpdateContext,
    release: CodexhostLatestRelease,
  ): Promise<boolean> {
    const staged = await readStagedUpdate(context.common.stateDirectory);
    if (
      !staged ||
      staged.version !== release.version ||
      staged.target !== context.metadata.target
    ) {
      return false;
    }
    if (context.installation.kind === "npm") {
      return staged.distribution === "npm";
    }
    if (staged.distribution !== "installer") return false;
    try {
      const selected = selectInstallerReleaseArtifact(release, context.metadata.target);
      const verified = await verifyStagedArtifact(
        context.common.stateDirectory,
        staged,
        selected.source,
      );
      return verified !== null;
    } catch {
      return false;
    }
  }

  function scheduleNextPeriodicCheck(): void {
    if (disposed || !backgroundConfig.enabled) return;
    if (scheduleTimer !== null) clearTimeout(scheduleTimer);
    const jitter =
      backgroundConfig.jitterMs > 0 ? Math.floor(Math.random() * backgroundConfig.jitterMs) : 0;
    const delayMs = Math.max(1, backgroundConfig.intervalMs + jitter);
    scheduleTimer = setTimeout(() => {
      scheduleTimer = null;
      void runBackgroundCycle();
    }, delayMs);
    unrefTimer(scheduleTimer);
  }

  function scheduleBackgroundRetry(version: string, failureCount: number): void {
    if (disposed || !backgroundConfig.enabled) return;
    if (failureCount > backgroundConfig.maxAutoRetries) return;
    const delayIndex = Math.min(failureCount - 1, backgroundConfig.retryDelaysMs.length - 1);
    const retryDelay = backgroundConfig.retryDelaysMs[delayIndex];
    if (retryDelay === undefined || retryDelay < 0) return;
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (disposed) return;
      if (retryState && retryState.version !== version) return;
      void runBackgroundCycle();
    }, retryDelay);
    unrefTimer(retryTimer);
  }

  async function stageReleaseInBackground(
    context: InstalledUpdateContext,
    release: CodexhostLatestRelease,
  ): Promise<void> {
    if (disposed) return;
    if (activeStaging) {
      if (activeStaging.version === release.version) {
        await activeStaging.promise;
      }
      return;
    }
    if (await isUpdateOperationActive(context.common.stateDirectory)) return;

    if (await hasVerifiedStagedRelease(context, release)) {
      stagedVersion = release.version;
      backgroundPhase = "ready";
      backgroundDownload = null;
      backgroundError = null;
      backgroundTargetVersion = release.version;
      retryState = null;
      return;
    }

    const jobVersion = release.version;
    backgroundTargetVersion = jobVersion;
    backgroundPhase = "downloading";
    backgroundDownload = null;
    backgroundError = null;
    stagedVersion = null;

    let stagingEntry: { version: string; promise: Promise<void> } | null = null;
    const job = (async (): Promise<void> => {
      try {
        if (context.installation.kind === "npm") {
          const npm = context.installation.options;
          await manager.stageNpm({
            stateDirectory: context.common.stateDirectory,
            version: jobVersion,
            target: context.metadata.target,
            npmTarget: {
              nodePath: npm.nodePath,
              npmCliPath: npm.npmCliPath,
              packageRoot: npm.packageRoot,
              version: jobVersion,
            },
          });
        } else {
          const selected = selectInstallerReleaseArtifact(release, context.metadata.target);
          await manager.stageArtifact({
            stateDirectory: context.common.stateDirectory,
            version: jobVersion,
            target: context.metadata.target,
            assetName: selected.name,
            source: selected.source,
            onProgress: (progress) => {
              if (disposed) return;
              if (progress.totalBytes !== undefined && progress.totalBytes > 0) {
                backgroundDownload = {
                  downloadedBytes: Math.min(progress.downloadedBytes, progress.totalBytes),
                  totalBytes: progress.totalBytes,
                };
              }
            },
          });
        }
        if (disposed) return;
        stagedVersion = jobVersion;
        backgroundPhase = "ready";
        backgroundDownload = null;
        backgroundError = null;
        retryState = null;
      } catch (error) {
        if (disposed) return;
        stagedVersion = null;
        backgroundPhase = "failed";
        backgroundDownload = null;
        backgroundError = boundedError(error);
        const failures =
          retryState && retryState.version === jobVersion ? retryState.failures + 1 : 1;
        retryState = { version: jobVersion, failures };
        scheduleBackgroundRetry(jobVersion, failures);
      } finally {
        if (stagingEntry !== null && activeStaging === stagingEntry) {
          activeStaging = null;
        }
      }
    })();

    stagingEntry = { version: jobVersion, promise: job };
    activeStaging = stagingEntry;
    await job;
  }

  async function runBackgroundCycle(): Promise<void> {
    if (disposed || !backgroundConfig.enabled) return;
    let context: InstalledUpdateContext;
    try {
      context = await installedContext();
    } catch {
      // Source checkout or incomplete runtime metadata: permanently disable background checks.
      clearTimers();
      return;
    }
    try {
      await cleanupStagedUpdates(context.common.stateDirectory, {
        currentVersion: context.metadata.version,
      });
      if (await isUpdateOperationActive(context.common.stateDirectory)) {
        return;
      }
      const release = await fetchLatest(backgroundAbort.signal).catch((error) =>
        npmFallbackRelease(context, error, backgroundAbort.signal),
      );
      if (disposed) return;
      candidate = release;
      const updateAvailable =
        compareSemanticVersions(context.metadata.version, release.version) < 0;
      if (!updateAvailable) {
        resetBackgroundState();
        retryState = null;
        return;
      }
      const { available } = await installable(context, release);
      if (disposed || !available) return;
      if (retryState && retryState.version !== release.version) {
        retryState = null;
        backgroundError = null;
      }
      await stageReleaseInBackground(context, release);
    } catch {
      // Discovery failure in background is non-fatal and retried on the next scheduled cycle.
    } finally {
      scheduleNextPeriodicCheck();
    }
  }

  if (backgroundConfig.enabled) {
    scheduleTimer = setTimeout(
      () => {
        scheduleTimer = null;
        void runBackgroundCycle();
      },
      Math.max(0, backgroundConfig.initialDelayMs),
    );
    unrefTimer(scheduleTimer);
  }

  function buildBackgroundFields(
    updateAvailable: boolean,
    releaseVersion: string | null,
    verifiedStaged: boolean,
  ): Pick<
    UpdateCheckResult,
    "stagedVersion" | "backgroundPhase" | "backgroundDownload" | "backgroundError"
  > {
    if (!updateAvailable || !releaseVersion) {
      return {
        stagedVersion: null,
        backgroundPhase: "idle",
        backgroundDownload: null,
        backgroundError: null,
      };
    }
    if (activeStaging && activeStaging.version === releaseVersion) {
      return {
        stagedVersion: null,
        backgroundPhase: "downloading",
        backgroundDownload,
        backgroundError: null,
      };
    }
    if (verifiedStaged) {
      stagedVersion = releaseVersion;
      backgroundPhase = "ready";
      backgroundDownload = null;
      backgroundError = null;
      backgroundTargetVersion = releaseVersion;
      return {
        stagedVersion: releaseVersion,
        backgroundPhase: "ready",
        backgroundDownload: null,
        backgroundError: null,
      };
    }
    if (backgroundPhase === "failed" && backgroundTargetVersion === releaseVersion) {
      return {
        stagedVersion: null,
        backgroundPhase: "failed",
        backgroundDownload: null,
        backgroundError,
      };
    }
    if (backgroundTargetVersion !== releaseVersion) {
      resetBackgroundState();
    }
    return {
      stagedVersion: null,
      backgroundPhase: "idle",
      backgroundDownload: null,
      backgroundError: null,
    };
  }

  return Object.freeze({
    async check(signal?: AbortSignal): Promise<UpdateCheckResult> {
      const taskCount = currentRunningTaskCount();
      let context: InstalledUpdateContext;
      try {
        context = await installedContext();
        await recoverUpdateOperationLock(context.common.stateDirectory);
        await cleanupTerminalUpdateState(context.common.stateDirectory);
        await cleanupStagedUpdates(context.common.stateDirectory, {
          currentVersion: context.metadata.version,
        });
      } catch (error) {
        const runtime = await readRuntimeMetadata(
          options.hostRuntimePath,
          options.environment,
        ).catch(() => null);
        return {
          currentVersion: runtime?.distribution === "development" ? runtime.version : "0.0.0",
          installation: null,
          latestVersion: null,
          updateAvailable: false,
          installationAvailable: false,
          releaseNotes: null,
          releaseNotesUrl: null,
          status: null,
          error: boundedError(error),
          ...(taskCount === undefined ? {} : { runningTaskCount: taskCount }),
        };
      }
      const status = await latestStatus(context);
      try {
        const release = await fetchLatest(signal).catch((error) =>
          npmFallbackRelease(context, error, signal),
        );
        candidate = release;
        const updateAvailable =
          compareSemanticVersions(context.metadata.version, release.version) < 0;
        const { available: installationAvailable, error } = updateAvailable
          ? await installable(context, release)
          : { available: false, error: null };
        const verifiedStaged =
          updateAvailable && installationAvailable
            ? await hasVerifiedStagedRelease(context, release)
            : false;
        const backgroundFields = buildBackgroundFields(
          updateAvailable,
          release.version,
          verifiedStaged,
        );
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
          ...backgroundFields,
          ...(taskCount === undefined ? {} : { runningTaskCount: taskCount }),
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
          ...(taskCount === undefined ? {} : { runningTaskCount: taskCount }),
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

      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }

      currentStatusPath = null;
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
        const release = await fetchLatest().catch((error) => npmFallbackRelease(context, error));
        if (
          compareSemanticVersions(context.metadata.version, release.version) >= 0 ||
          (candidate && candidate.version !== release.version)
        ) {
          throw new Error("The selected update is no longer the current GitHub Release");
        }
        const inFlightStaging =
          activeStaging && activeStaging.version === release.version ? activeStaging.promise : null;
        const waitForStaged = inFlightStaging
          ? () => inFlightStaging.catch(() => undefined)
          : undefined;

        const onPrepared = async (info: {
          version: string;
          installation: BackgroundUpdateStatus["installation"];
          statusPath: string;
        }): Promise<void> => {
          await lock.setStatusPath(info.statusPath);
          currentStatusPath = info.statusPath;
          resolvePrepared(info);
        };
        const prepareAndStart = async (): Promise<void> => {
          try {
            let prepared;
            if (context.installation.kind === "npm") {
              prepared = await manager.prepareNpm({
                ...context.installation.options,
                version: release.version,
                target: context.metadata.target,
                onPrepared,
                ...(waitForStaged ? { waitForStaged } : {}),
              });
            } else {
              const artifact = selectInstallerReleaseArtifact(
                release,
                context.metadata.target,
              ).source;
              const installation = context.installation;
              const commonPrepareOptions = {
                version: release.version,
                artifact,
                onPrepared,
                ...(waitForStaged ? { waitForStaged } : {}),
              };
              prepared =
                installation.kind === "windows-installer"
                  ? await manager.prepareWindowsInstaller({
                      ...installation.options,
                      ...commonPrepareOptions,
                    })
                  : installation.kind === "macos-dmg"
                    ? await manager.prepareMacOsDmg({
                        ...installation.options,
                        ...commonPrepareOptions,
                      })
                    : await manager.prepareLinuxArchive({
                        ...installation.options,
                        ...commonPrepareOptions,
                      });
            }
            // The Launcher starts the Updater on macOS and Windows. On Windows the
            // Host Runtime runs in the Shim's kill-on-close Job, so an Updater it
            // started would be killed together with the Desktop it waits for.
            if (!context.common.serviceManaged && platform !== "darwin" && platform !== "win32")
              await manager.start(prepared, (pid) => lock.transferTo(pid));
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

    async macosSigning(action: "status" | "setup" | "remove"): Promise<MacOsLocalSigningStatus> {
      if (platform !== "darwin") return UNSUPPORTED_MACOS_SIGNING_STATUS;
      let context: InstalledUpdateContext;
      try {
        context = await installedContext();
      } catch {
        if (action === "status") return UNSUPPORTED_MACOS_SIGNING_STATUS;
        throw new Error("macOS local signing requires an installed macOS app bundle");
      }
      if (context.installation.kind !== "macos-dmg") {
        if (action === "status") return UNSUPPORTED_MACOS_SIGNING_STATUS;
        throw new Error("macOS local signing is only available for the macOS app bundle");
      }
      const appPath = context.installation.options.appPath;
      const launcher =
        options.environment?.CODEXHOST_LAUNCHER_EXECUTABLE ??
        path.join(appPath, "Contents", "MacOS", "codexhost");
      const args = ["macos-signing", action, "--json", "--app", appPath];
      const timeout = action === "setup" ? 120_000 : 30_000;
      try {
        const { stdout } = await execFileAsync(launcher, args, {
          env: {
            ...process.env,
            ...options.environment,
            ...(context.common.dataDirectory
              ? { CODEXHOST_DATA_DIR: context.common.dataDirectory }
              : {}),
          },
          timeout,
          maxBuffer: 256 * 1024,
        });
        return macosLocalSigningStatusSchema.parse(JSON.parse(stdout.trim()));
      } catch (error) {
        const stderr =
          typeof error === "object" &&
          error !== null &&
          "stderr" in error &&
          typeof (error as { stderr?: unknown }).stderr === "string"
            ? (error as { stderr: string }).stderr.trim()
            : "";
        throw new Error(stderr || boundedError(error));
      }
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearTimers();
      backgroundAbort.abort();
    },
  });
}
