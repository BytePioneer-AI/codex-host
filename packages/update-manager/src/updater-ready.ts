import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import type { BackgroundUpdateStatus } from "./status.js";

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
