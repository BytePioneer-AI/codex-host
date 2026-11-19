import {
  createInstallationManager,
  newerInstallationVersion,
  npmInstallation,
  runInstallationCommand,
  versionFromOutput,
} from "@codexhost/harness-discovery";
import { resolveCopilotExecutable } from "./command.js";

export function createCopilotInstallation(environment: NodeJS.ProcessEnv) {
  return createInstallationManager({
    async check() {
      const command = resolveCopilotExecutable({ environment });
      const currentVersion = versionFromOutput(
        await runInstallationCommand(command, ["--version"], environment),
      );
      const installation = await npmInstallation(command, ["@github/copilot"], environment);
      const latestVersion = await installation?.latest().catch(() => undefined);
      return {
        currentVersion,
        latestVersion: latestVersion ?? "Unknown",
        ...(latestVersion ? {} : { latestVersionKind: "unknown" as const }),
        updateAvailable: !!latestVersion && newerInstallationVersion(currentVersion, latestVersion),
        canUpdate: !!installation?.canUpdate,
        ...(!installation?.canUpdate
          ? {
              notice: {
                en: "Update Copilot using the package manager that installed this CLI.",
                "zh-CN": "请使用安装当前 Copilot CLI 的包管理器更新。",
              },
            }
          : {}),
      };
    },
    async update(state) {
      const command = resolveCopilotExecutable({ environment });
      const installation = await npmInstallation(command, ["@github/copilot"], environment);
      if (!installation?.canUpdate || installation.currentVersion !== state.currentVersion)
        throw new Error("Copilot installation changed; check it again before updating.");
      await installation.update(state.latestVersion);
    },
  });
}
