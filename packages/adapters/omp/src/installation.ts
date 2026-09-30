import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  createInstallationManager,
  installationVersion,
  newerInstallationVersion,
  resolveHarnessExecutable,
  runInstallationCommand,
  versionFromOutput,
} from "@codexhost/harness-discovery";
import { resolveOmpExecutable } from "./command.js";

export function createOmpInstallation(environment: NodeJS.ProcessEnv, command?: string) {
  let executable: string;
  let env: NodeJS.ProcessEnv;
  return createInstallationManager({
    async check() {
      executable = resolveOmpExecutable({ environment, ...(command ? { command } : {}) });
      const selected = await realpath(executable);
      // omp's updater selects its target from PATH. Keep it on this installation.
      const pathKey =
        Object.keys(environment).find((key) => key.toLowerCase() === "path") ?? "PATH";
      env = {
        ...environment,
        [pathKey]: `${path.dirname(executable)}${path.delimiter}${environment[pathKey] ?? ""}`,
      };
      const target = resolveHarnessExecutable(
        { id: "omp", command: "omp", installRoots: { posix: [], windows: [] } },
        { environment: env },
      );
      const canUpdate =
        !selected.includes("/nix/store/") &&
        !!target &&
        (await realpath(target.executable)) === selected;
      const output = await runInstallationCommand(executable, ["update", "--check"], env);
      const currentVersion = versionFromOutput(output);
      const available = output.match(/New version available:\s*(\S+)/i);
      if (!available && !/already up to date/i.test(output))
        throw new Error("OMP update check returned an unknown response");
      const latestVersion = available ? installationVersion(available[1]) : currentVersion;
      return {
        currentVersion,
        latestVersion,
        updateAvailable: newerInstallationVersion(currentVersion, latestVersion),
        canUpdate,
        ...(!canUpdate
          ? { message: "Update this installation with its original package manager or launcher." }
          : {}),
      };
    },
    async update() {
      await runInstallationCommand(executable, ["update"], env, 300_000);
    },
  });
}
