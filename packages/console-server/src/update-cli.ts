import { setTimeout as delay } from "node:timers/promises";
import type { UpdateStatus } from "@codexhost/shared-contracts";

import { inspectInstallation, resolveInstallation } from "./installation.js";
import { createConsoleHostClient, createHostUpdates } from "./host-client.js";
import { consolePaths } from "./paths.js";
import { createConsoleUpdates, type ConsoleUpdates, type ConsoleUpdateTarget } from "./updates.js";

const POLL_INTERVAL_MS = 500;
const DOWNLOAD_IDLE_TIMEOUT_MS = 15 * 60_000;

function downloadMessage(status: UpdateStatus): string {
  const prefix = "Downloading update...";
  if (status.npmDownload) {
    return `${prefix} ${status.npmDownload.completed}/${status.npmDownload.total} npm packages ready`;
  }
  if (status.downloadedBytes === undefined) return prefix;
  const mib = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  const downloaded = mib(status.downloadedBytes);
  if (status.totalBytes === undefined) return `${prefix} ${downloaded}`;
  const percent = Math.floor((status.downloadedBytes / status.totalBytes) * 100);
  return `${prefix} ${percent}% (${downloaded} / ${mib(status.totalBytes)})`;
}

/** Shares the console's release selection, operation lock and native installer. */
export async function runUpdateCommand(
  target: ConsoleUpdateTarget,
  updates: ConsoleUpdates,
  write: (message: string, live?: boolean) => void = (message) => console.log(message),
): Promise<void> {
  write("Checking for codexhost updates...");
  const checked = await updates.check(target);
  if (checked.error) throw new Error(checked.error);
  if (!checked.updateAvailable) {
    write(`codexhost ${checked.currentVersion} is up to date.`);
    return;
  }
  // Without an error, the release is not yet in the npm registry this installation uses.
  if (!checked.installationAvailable) {
    throw new Error(
      `codexhost ${checked.latestVersion} is released but your npm registry does not have it yet; retry later`,
    );
  }
  write(`Updating codexhost ${checked.currentVersion} → ${checked.latestVersion}...`);
  let lastProgress: string | undefined;
  const report = (status: UpdateStatus | null): void => {
    if (status?.phase !== "downloading" || status.version !== checked.latestVersion) return;
    const message = downloadMessage(status);
    if (message === lastProgress) return;
    lastProgress = message;
    write(message, true);
  };
  const starting = updates.start(target).then(({ status }) => status);
  // The standalone path waits for handoff. The Host can respond while it is still downloading.
  const startOrPoll = () => Promise.race([starting, delay(POLL_INTERVAL_MS, null, { ref: false })]);
  let status = await startOrPoll();
  while (status === null) {
    report((await updates.status()).status);
    status = await startOrPoll();
  }
  const waitingSince = Date.now();
  while (status.phase === "downloading") {
    report(status);
    if (Date.now() - Math.max(waitingSince, status.updatedAt * 1_000) >= DOWNLOAD_IDLE_TIMEOUT_MS)
      throw new Error("Timed out waiting for download progress");
    await delay(POLL_INTERVAL_MS);
    const current = (await updates.status()).status;
    if (current?.version === status.version && current.installation === status.installation)
      status = current;
  }
  if (status.phase === "failed") throw new Error(status.error ?? "Update failed");
  if (lastProgress) write("Download complete.");
  if (status.phase === "succeeded") {
    write(`Update ${status.version}: installed successfully.`);
    return;
  }
  write(
    `Update ${status.version}: ${status.phase}. The update request was accepted; installation is not complete yet. The background updater will install it and restart codexhost.`,
  );
}

export async function updateFromCommand(appDirectory: string, arguments_: string[]): Promise<void> {
  if (arguments_.length > 0) throw new Error("update accepts no arguments");
  const installation = await resolveInstallation(appDirectory);
  if (!installation.distribution) throw new Error("A source checkout cannot update itself");
  if (!installation.launcherExecutable) throw new Error("The codexhost Launcher is unavailable");
  const paths = consolePaths();
  const host = createConsoleHostClient(paths.hostDescriptorDirectory, {
    updateAppDirectory: appDirectory,
  });
  const inspected = await inspectInstallation(installation.launcherExecutable);
  const local = createConsoleUpdates({ waitForHandoff: true, onHandedOff() {} });
  // The local status file remains readable while the Host is being restarted.
  const updates = (await host.available())
    ? { ...createHostUpdates(host), status: local.status }
    : local;
  const output = process.stdout;
  let progressVisible = false;
  const clearProgress = (): void => {
    if (!progressVisible) return;
    output.clearLine(0);
    output.cursorTo(0);
    progressVisible = false;
  };
  try {
    await runUpdateCommand(
      {
        ...installation,
        runtimeDescriptorPath: inspected.runtime.descriptorPath,
        codexhostRunning: inspected.runtime.running,
        dataDirectory: paths.dataDirectory,
        restartTarget: inspected.desktop === null ? "web" : "desktop",
      },
      updates,
      (message, live) => {
        clearProgress();
        if (live && output.isTTY) {
          output.write(message);
          progressVisible = true;
        } else {
          console.log(message);
        }
      },
    );
  } finally {
    clearProgress();
  }
}
