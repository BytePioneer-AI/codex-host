import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  createInstallationManager,
  fetchInstallationText,
  installationVersion,
  newerInstallationVersion,
  npmInstallation,
  runInstallationCommand,
  versionFromOutput,
} from "@codexhost/harness-discovery";
import { resolveOpenCodeExecutable } from "./command.js";

export function createOpenCodeInstallation(environment: NodeJS.ProcessEnv, command?: string) {
  let update: (version: string) => Promise<void>;
  return createInstallationManager({
    async check() {
      const executable = resolveOpenCodeExecutable({
        environment,
        ...(command ? { command } : {}),
      });
      const currentVersion = versionFromOutput(
        await runInstallationCommand(executable, ["--version"], environment),
      );
      const npm = await npmInstallation(executable, ["opencode-ai"], environment);
      let latestVersion: string;
      let canUpdate: boolean;
      if (npm) {
        latestVersion = await npm.latest();
        canUpdate = npm.canUpdate;
        update = npm.update;
      } else {
        const release = JSON.parse(
          await fetchInstallationText(
            "https://api.github.com/repos/anomalyco/opencode/releases/latest",
          ),
        ) as { tag_name?: string };
        latestVersion = installationVersion(release.tag_name);
        const home = environment.HOME ?? environment.USERPROFILE ?? homedir();
        const standard = path.join(
          home,
          ".opencode",
          "bin",
          process.platform === "win32" ? "opencode.exe" : "opencode",
        );
        canUpdate =
          process.platform !== "win32" &&
          path.resolve(executable) === standard &&
          (await realpath(executable)) === standard;
        // Unknown/package-managed installs must not enter upgrade's interactive fallback.
        update = async (version) => {
          await runInstallationCommand(
            executable,
            ["upgrade", version, "--method", "curl"],
            environment,
            300_000,
          );
        };
      }
      return {
        currentVersion,
        latestVersion,
        updateAvailable: newerInstallationVersion(currentVersion, latestVersion),
        canUpdate,
        ...(!canUpdate
          ? { message: "Use the original package manager to update this OpenCode installation." }
          : {}),
      };
    },
    async update(state) {
      await update(state.latestVersion);
    },
  });
}
