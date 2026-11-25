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

const NATIVE_MAJOR_UPGRADE_MESSAGE =
  "OpenCode 1.x native installations cannot be upgraded to 2.x automatically; run 'opencode upgrade --major' or install from https://opencode.ai/v2/install.";

export function createOpenCodeInstallation(environment: NodeJS.ProcessEnv, command?: string) {
  let update: ((version: string) => Promise<void>) | undefined;
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
      update = undefined;
      if (npm) {
        latestVersion = await npm.latest();
        canUpdate = npm.canUpdate;
        update = npm.canUpdate ? npm.update : undefined;
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
      }
      const updateAvailable = newerInstallationVersion(currentVersion, latestVersion);
      const majorV1ToV2 = currentVersion.startsWith("1.") && latestVersion.startsWith("2.");
      const nativeMajorUpgrade = !npm && canUpdate && updateAvailable && majorV1ToV2;
      if (nativeMajorUpgrade) canUpdate = false;
      if (!npm && canUpdate) {
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
        updateAvailable,
        canUpdate,
        ...(majorV1ToV2
          ? {
              notice: nativeMajorUpgrade
                ? {
                    en: "OpenCode 2.x starts a new major version: Sessions created with 1.x cannot be resumed after the upgrade. Upgrade manually with 'opencode upgrade --major' or install from https://opencode.ai/v2/install.",
                    "zh-CN":
                      "OpenCode 2.x 是新的大版本：升级后无法再恢复 1.x 创建的会话。请手动执行 'opencode upgrade --major' 或通过 https://opencode.ai/v2/install 升级。",
                  }
                : {
                    en: "OpenCode 2.x starts a new major version: Sessions created with 1.x cannot be resumed after the upgrade.",
                    "zh-CN": "OpenCode 2.x 是新的大版本：升级后无法再恢复 1.x 创建的会话。",
                  },
            }
          : {}),
        ...(!canUpdate
          ? nativeMajorUpgrade
            ? {
                messageCode: "opencode-major-upgrade",
                message: NATIVE_MAJOR_UPGRADE_MESSAGE,
              }
            : {
                messageCode: "original-installer",
                message: "Use the original package manager to update this OpenCode installation.",
              }
          : {}),
      };
    },
    async update(state) {
      if (!state.canUpdate || !update) {
        throw new Error(
          state.message ?? "This OpenCode installation cannot be updated automatically.",
        );
      }
      await update(state.latestVersion);
    },
  });
}
