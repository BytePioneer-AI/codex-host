import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { parseUpdateStatus, type BackgroundUpdateStatus } from "./status.js";
import { discoverActiveUpdateStatus } from "./operation-state.js";
import { sameWindowsPath } from "./windows-installation.js";

export interface UpdateResultScope {
  installation: BackgroundUpdateStatus["installation"];
  installationRoot: string;
  runtimeDescriptorPath: string;
  launcherPid?: number;
  launcherStartedAtMicros?: string;
  version?: string;
}
async function json(file: string): Promise<Record<string, unknown>> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536)
    throw new Error("invalid operation file");
  return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
}
export async function updateStatusMatchesInstallation(
  file: string,
  scope: UpdateResultScope,
): Promise<boolean> {
  try {
    const directory = path.dirname(file),
      info = await lstat(directory);
    if (
      path.basename(file) !== "status-v1.json" ||
      !path.basename(directory).startsWith("update-") ||
      !info.isDirectory() ||
      info.isSymbolicLink()
    )
      return false;
    const request = await json(path.join(directory, "request-v1.json"));
    const installation = request.installation as Record<string, unknown>;
    if (
      request.schema_version !== 1 ||
      installation?.kind !== scope.installation ||
      typeof request.status_path !== "string" ||
      typeof request.runtime_descriptor_path !== "string"
    )
      return false;
    const root = installation.kind === "npm" ? installation.prefix : installation.install_root;
    if (
      typeof root !== "string" ||
      !path.isAbsolute(root) ||
      !path.isAbsolute(file) ||
      !sameWindowsPath(await realpath(root), await realpath(scope.installationRoot)) ||
      !sameWindowsPath(request.status_path, file) ||
      !sameWindowsPath(request.runtime_descriptor_path, scope.runtimeDescriptorPath)
    )
      return false;
    const status = parseUpdateStatus(await json(file));
    return status.version === request.version && status.installation === scope.installation;
  } catch {
    return false;
  }
}
export async function updateRepairRequired(
  stateDirectory: string,
  scope: UpdateResultScope,
): Promise<string | null> {
  const active = await discoverActiveUpdateStatus(stateDirectory);
  return active?.status.phase === "failed" &&
    (await updateStatusMatchesInstallation(active.statusPath, scope))
    ? `An unfinished update still protects this installation. Repair through its original channel and prefix/directory ${scope.installationRoot}; retained materials must not be overwritten automatically.`
    : null;
}

/** Only the current Launcher birth or this installation's active operation, never newest history. */
export async function discoverCurrentUpdateStatus(
  stateDirectory: string,
  scope: UpdateResultScope,
): Promise<{ statusPath: string; status: BackgroundUpdateStatus } | null> {
  const active = await discoverActiveUpdateStatus(stateDirectory);
  if (
    active &&
    sameWindowsPath(
      await realpath(path.dirname(path.dirname(active.statusPath))),
      await realpath(stateDirectory),
    ) &&
    (await updateStatusMatchesInstallation(active.statusPath, scope))
  ) {
    const request = await json(path.join(path.dirname(active.statusPath), "request-v1.json"));
    // A new operation owned by this Launcher takes precedence over the result
    // of the update that originally started it.
    if (
      !scope.launcherPid ||
      (request.wait_pid === scope.launcherPid &&
        request.wait_started_at_micros === scope.launcherStartedAtMicros)
    )
      return active;
  }
  const matches = [];
  if (scope.launcherPid && scope.launcherStartedAtMicros && scope.version) {
    for (const entry of await readdir(stateDirectory, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith("update-"))
        continue;
      const statusPath = path.join(stateDirectory, entry.name, "status-v1.json");
      try {
        const status = parseUpdateStatus(await json(statusPath)),
          r = status.restart;
        if (
          !r ||
          r.launcherPid !== scope.launcherPid ||
          r.launcherStartedAtMicros !== scope.launcherStartedAtMicros ||
          r.version !== scope.version ||
          !sameWindowsPath(
            await realpath(r.installationRoot),
            await realpath(scope.installationRoot),
          ) ||
          !(await updateStatusMatchesInstallation(statusPath, scope))
        )
          continue;
        matches.push({ statusPath, status });
      } catch {
        /* Partial or incompatible local state is not an association. */
      }
    }
  }
  return matches.length === 1 ? (matches[0] ?? null) : null;
}
