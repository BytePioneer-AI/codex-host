import { runInstallationCommand, versionFromOutput } from "@codexhost/harness-discovery";
import { resolveKiroExecutable } from "./command.js";

/** Kiro's update policy and release selection belong to its native installer. */
export function createKiroInstallation(environment: NodeJS.ProcessEnv, command?: string) {
  return async (action: "check" | "update") => {
    if (action === "update") throw new Error("Use Kiro CLI's original installer to update");
    const executable = resolveKiroExecutable({ environment, ...(command ? { command } : {}) });
    const currentVersion = versionFromOutput(
      await runInstallationCommand(executable, ["--version"], environment),
    );
    return {
      currentVersion,
      latestVersion: "Unknown",
      updateAvailable: false,
      canUpdate: false,
      messageCode: "kiro-native-updater",
      notice: {
        en: "Use Kiro CLI's original installer or native updater to check for and install updates.",
        "zh-CN": "请使用 Kiro CLI 原安装程序或原生更新器检查并安装更新。",
      },
      message:
        "Use Kiro CLI's original installer or native updater to check for and install updates.",
    };
  };
}
