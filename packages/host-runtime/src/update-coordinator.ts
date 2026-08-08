import { createConnection } from "node:net";

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
  recoverUpdateOperationLock,
  resolveInstalledUpdateContext,
  selectInstallerReleaseArtifact,
  type BackgroundUpdateManager,
  type BackgroundUpdateStatus,
  type CodexhostLatestRelease,
  type InstalledUpdateContext,
} from "@codexhost/update-manager";

const ERROR_MAX_LENGTH = 500;
const CONTROLLER_TIMEOUT_MS = 5_000;

export interface HostUpdateCoordinator {
  check(signal?: AbortSignal): Promise<UpdateCheckResult>;
  start(): Promise<UpdateStartResult>;
  status(): Promise<UpdateStatusResult>;
  requestShutdown(): void;
}

export type CompatibilityUpdateOutcome = "update-started" | "current" | "unavailable";

export async function startCompatibilityUpdate(
  coordinator: Pick<HostUpdateCoordinator, "check" | "start">,
): Promise<CompatibilityUpdateOutcome> {
  try {
    const check = await coordinator.check();
    if (check.updateAvailable && check.installationAvailable) {
      void coordinator.start().catch(() => undefined);
      return "update-started";
    }
    if (
      check.error === null &&
      check.latestVersion !== null &&
      check.currentVersion === check.latestVersion
    ) {
      return "current";
    }
  } catch {
    // The native prompt presents a bounded fallback without exposing update errors.
  }
  return "unavailable";
}

export interface CreateHostUpdateCoordinatorOptions {
  hostRuntimePath: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  architecture?: string;
  manager?: BackgroundUpdateManager;
  fetchLatest?(signal?: AbortSignal): Promise<CodexhostLatestRelease>;
  shutdown?(controller: { port: number; nonce: string }): Promise<void>;
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
    error: status.error?.slice(0, ERROR_MAX_LENGTH) ?? null,
  };
}

export function requestControllerShutdown(controller: {
  port: number;
  nonce: string;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: controller.port });
    let response = "";
    const timeout = setTimeout(
      () => socket.destroy(new Error("Controller shutdown timed out")),
      CONTROLLER_TIMEOUT_MS,
    );
    const settle = (operation: () => void): void => {
      clearTimeout(timeout);
      operation();
    };
    socket.setEncoding("utf8");
    socket.once("error", (error) => settle(() => reject(error)));
    socket.on("data", (chunk: string) => {
      response += chunk;
    });
    socket.once("end", () =>
      settle(() => {
        if (response === "ready\n") resolve();
        else reject(new Error("Desktop Controller rejected the shutdown request"));
      }),
    );
    socket.once("connect", () => socket.write(`SHUTDOWN ${controller.nonce}\n`));
  });
}

export function createHostUpdateCoordinator(
  options: CreateHostUpdateCoordinatorOptions,
): HostUpdateCoordinator {
  const manager =
    options.manager ??
    createBackgroundUpdateManager(options.platform ? { platform: options.platform } : {});
  const contextPromise = resolveInstalledUpdateContext({
    hostRuntimePath: options.hostRuntimePath,
    ...(options.environment ? { environment: options.environment } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.architecture ? { architecture: options.architecture } : {}),
  });
  const fetchLatest: (signal?: AbortSignal) => Promise<CodexhostLatestRelease> =
    options.fetchLatest ??
    ((signal?: AbortSignal) =>
      fetchLatestGitHubRelease({ signal: signal ?? AbortSignal.timeout(15_000) }));
  const shutdown = options.shutdown ?? requestControllerShutdown;
  let candidate: CodexhostLatestRelease | null = null;
  let shutdownPending: InstalledUpdateContext["controller"] | null = null;

  async function latestStatus(context: InstalledUpdateContext): Promise<UpdateStatus | null> {
    const discovered = await discoverLatestUpdateStatus(context.common.stateDirectory);
    return discovered ? publicStatus(discovered.status) : null;
  }

  async function installable(
    context: InstalledUpdateContext,
    release: CodexhostLatestRelease,
  ): Promise<boolean> {
    if (context.metadata.distribution === "npm") return true;
    try {
      selectInstallerReleaseArtifact(release, context.metadata.target);
      return true;
    } catch {
      return false;
    }
  }

  return Object.freeze({
    async check(signal?: AbortSignal): Promise<UpdateCheckResult> {
      let context: InstalledUpdateContext;
      try {
        context = await contextPromise;
        await recoverUpdateOperationLock(context.common.stateDirectory);
        await cleanupTerminalUpdateState(context.common.stateDirectory);
      } catch (error) {
        return {
          currentVersion: "0.0.0",
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
      const context = await contextPromise;
      await recoverUpdateOperationLock(context.common.stateDirectory);
      const lock = await acquireUpdateOperationLock(context.common.stateDirectory);
      if (!lock) {
        const existing = await latestStatus(context);
        if (existing) return { status: existing };
        throw new Error("Another update operation is already active");
      }
      try {
        const release = await fetchLatest();
        if (
          compareSemanticVersions(context.metadata.version, release.version) >= 0 ||
          (candidate && candidate.version !== release.version)
        ) {
          throw new Error("The selected update is no longer the current GitHub Release");
        }
        let prepared;
        if (context.installation.kind === "npm") {
          prepared = await manager.prepareNpm({
            ...context.installation.options,
            version: release.version,
          });
        } else {
          const artifact = selectInstallerReleaseArtifact(release, context.metadata.target).source;
          prepared =
            context.installation.kind === "windows-installer"
              ? await manager.prepareWindowsInstaller({
                  ...context.installation.options,
                  version: release.version,
                  artifact,
                })
              : await manager.prepareMacOsDmg({
                  ...context.installation.options,
                  version: release.version,
                  artifact,
                });
        }
        await lock.setStatusPath(prepared.statusPath);
        manager.start(prepared);
        const status = await manager.readStatus(prepared.statusPath);
        if (!status) throw new Error("Background Updater did not create status");
        shutdownPending = context.controller;
        return { status: publicStatus(status) };
      } catch (error) {
        await lock.release();
        throw error;
      }
    },

    async status(): Promise<UpdateStatusResult> {
      try {
        const context = await contextPromise;
        await recoverUpdateOperationLock(context.common.stateDirectory);
        return { status: await latestStatus(context) };
      } catch {
        return { status: null };
      }
    },

    requestShutdown(): void {
      const controller = shutdownPending;
      shutdownPending = null;
      if (!controller) return;
      setTimeout(() => void shutdown(controller).catch(() => undefined), 50).unref();
    },
  });
}
