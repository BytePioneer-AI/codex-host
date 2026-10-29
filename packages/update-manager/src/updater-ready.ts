import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import type { BackgroundUpdateStatus } from "./status.js";
import { requestLauncherUpdate, type LauncherRequest } from "./launcher-update.js";
import type { WindowsProcessIdentity } from "./windows-process-identity.js";

/** Route Windows Desktop startup through the owner outside the old Job.
 * Standalone owners and non-Windows retain direct spawn + ready handoff. */
export async function startUpdater(options: {
  platform: NodeJS.Platform;
  prepared: { helperPath: string; requestPath: string };
  owner: LauncherRequest;
  spawnUpdater(executable: string, requestPath: string): ChildProcess;
  readStatus(): Promise<BackgroundUpdateStatus | null>;
  readIdentity?(pid: number): Promise<WindowsProcessIdentity>;
}): Promise<number | undefined> {
  if (options.platform === "win32" && options.owner.wait_pid !== process.pid) {
    await requestLauncherUpdate(options.prepared.requestPath, options.owner, options.readIdentity);
    return undefined; // Intent is not an acknowledgement/PID.
  }
  const child = options.spawnUpdater(options.prepared.helperPath, options.prepared.requestPath);
  await waitForUpdaterReady(child, options.readStatus);
  if (!child.pid) throw new Error("background Updater did not receive a process ID");
  return child.pid;
}

/** Keep the owner alive until the native Updater has validated its identity. */
export async function waitForUpdaterReady(
  child: ChildProcess,
  readStatus: () => Promise<BackgroundUpdateStatus | null>,
  timeoutMs = 10_000,
): Promise<void> {
  let failure: Error | undefined;
  const onError = (error: Error): void => {
    failure = error;
  };
  const onExit = (): void => {
    failure = new Error("Background Updater exited before completing handoff");
  };
  child.on("error", onError);
  child.on("exit", onExit);
  const deadline = performance.now() + timeoutMs;
  try {
    while (true) {
      const status = await readStatus();
      if (status?.phase === "failed") throw new Error(status.error ?? "Background Updater failed");
      if (failure) throw failure;
      if (child.exitCode != null || child.signalCode != null) {
        throw new Error("Background Updater exited before completing handoff");
      }
      if (status?.phase === "waiting-for-exit") return;
      if (status && status.phase !== "prepared") {
        throw new Error(`Unexpected Updater phase during handoff: ${status.phase}`);
      }
      if (performance.now() >= deadline) {
        throw new Error("Background Updater did not confirm handoff before the startup timeout");
      }
      await delay(20);
    }
  } catch (error) {
    // A late-starting helper must not install after the caller reports failure.
    child.kill();
    throw error;
  } finally {
    child.removeListener("error", onError);
    child.removeListener("exit", onExit);
  }
}
