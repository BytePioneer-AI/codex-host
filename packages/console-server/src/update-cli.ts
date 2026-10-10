import { inspectInstallation, resolveInstallation } from "./installation.js";
import { createConsoleUpdates, type ConsoleUpdates, type ConsoleUpdateTarget } from "./updates.js";

/** Shares the console's release selection, operation lock and native installer. */
export async function runUpdateCommand(
  target: ConsoleUpdateTarget,
  updates: ConsoleUpdates,
  write: (message: string) => void = console.log,
): Promise<void> {
  write("Checking for codexhost updates...");
  const checked = await updates.check(target);
  if (checked.error) throw new Error(checked.error);
  if (!checked.updateAvailable) {
    write(`codexhost ${checked.currentVersion} is up to date.`);
    return;
  }
  if (!checked.installationAvailable) throw new Error("No supported update for this installation");
  write(`Updating codexhost ${checked.currentVersion} → ${checked.latestVersion}...`);
  const { status } = await updates.start(target);
  if (status.phase === "failed") throw new Error(status.error ?? "Update failed");
  write(
    `Update ${status.version}: ${status.phase}. The background updater has accepted the handoff; installation is not complete yet. It will install the update and restart codexhost.`,
  );
}

export async function updateFromCommand(appDirectory: string, arguments_: string[]): Promise<void> {
  if (arguments_.length > 0) throw new Error("update accepts no arguments");
  const installation = await resolveInstallation(appDirectory);
  if (!installation.distribution) throw new Error("A source checkout cannot update itself");
  if (!installation.launcherExecutable) throw new Error("The codexhost Launcher is unavailable");
  const inspected = await inspectInstallation(installation.launcherExecutable);
  await runUpdateCommand(
    {
      ...installation,
      runtimeDescriptorPath: inspected.runtime.descriptorPath,
      codexhostRunning: inspected.runtime.running,
    },
    createConsoleUpdates({ waitForHandoff: true, onHandedOff() {} }),
  );
}
