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
} from "@codexhost/harness-discovery";
import { resolveOpenCodeExecutable } from "./command.js";
import { openCodeVersion } from "./version.js";

export function createOpenCodeInstallation(environment: NodeJS.ProcessEnv, command?: string) {
  let update: (version: string) => Promise<void>;
  return createInstallationManager({
    async check() {
      const executable = resolveOpenCodeExecutable({
        environment,
        ...(command ? { command } : {}),
      });
      const currentVersion = openCodeVersion(
        await runInstallationCommand(executable, ["--version"], environment),
      );
      const npm = await npmInstallation(executable, ["@opencode/cli", "opencode-ai"], environment, {
        successor: "@opencode/cli",
        allowScripts: "@opencode/cli",
      });
      let latestVersion: string;
      let canUpdate: boolean;
      if (npm) {
        latestVersion = await npm.latest();
        canUpdate = npm.canUpdate;
        update = npm.update;
      } else {
        const latest = JSON.parse(
          await fetchInstallationText(
            `https://registry.npmjs.org/${encodeURIComponent("@opencode/cli")}/latest`,
          ),
        ) as { version?: string };
        latestVersion = installationVersion(latest.version);
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
        ...(currentVersion.startsWith("1.") && latestVersion.startsWith("2.")
          ? {
              notice: {
                en: "OpenCode 2.x starts a new major version: Sessions created with 1.x cannot be resumed after the upgrade.",
                "zh-CN": "OpenCode 2.x 是新的大版本：升级后无法再恢复 1.x 创建的会话。",
              },
            }
          : {}),
        ...(!canUpdate
          ? {
              messageCode: "original-installer",
              message: "Use the original package manager to update this OpenCode installation.",
            }
          : {}),
      };
    },
    async update(state) {
      await update(state.latestVersion);
    },
  });
}
