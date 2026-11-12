import { inspectInstallation, resolveInstallation } from "./installation.js";
import { createConsoleHostClient, createHostUpdates } from "./host-client.js";
import { consolePaths } from "./paths.js";
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
  if (!checked.installationAvailable) {
    // Windows and macOS Updaters require a Launcher cleanup handoff, which a terminal cannot grant.
    // Linux installer targets have no in-app installer either, so only a manual install remains.
    const release = checked.releaseNotesUrl ? ` (${checked.releaseNotesUrl})` : "";
    const linuxInstaller =
      target.distribution?.distribution === "installer" &&
      target.distribution.target.startsWith("linux-");
    const next = linuxInstaller
      ? "Install the release manually"
      : "Update from Codex settings, or install the release manually";
    throw new Error(
      `codexhost ${checked.latestVersion} is available but cannot be installed from the terminal here. ${next}${release}.`,
    );
  }
  write(`Updating codexhost ${checked.currentVersion} → ${checked.latestVersion}...`);
  const { status } = await updates.start(target);
  if (status.phase === "failed") throw new Error(status.error ?? "Update failed");
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
  await runUpdateCommand(
    {
      ...installation,
      runtimeDescriptorPath: inspected.runtime.descriptorPath,
      codexhostRunning: inspected.runtime.running,
      dataDirectory: paths.dataDirectory,
      restartTarget: inspected.desktop === null ? "web" : "desktop",
    },
    (await host.available())
      ? createHostUpdates(host)
      : createConsoleUpdates({ waitForHandoff: true, onHandedOff() {} }),
  );
}
