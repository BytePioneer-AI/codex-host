import { runInstallationCommand, versionFromOutput } from "@codexhost/harness-discovery";
import { resolveTrae } from "./command.js";

export function createTraeInstallation(environment: NodeJS.ProcessEnv, command?: string) {
  const env = { ...process.env, ...environment };
  return async (action: "check" | "update") => {
    if (action === "update") throw new Error("Use the Trae CLI native updater: traecli update");
    const executable = resolveTrae(env, command);
    const currentVersion = versionFromOutput(
      await runInstallationCommand(executable, ["--version"], env),
    );
    return {
      currentVersion,
      latestVersion: "Unknown",
      latestVersionKind: "unknown" as const,
      updateAvailable: false,
      canUpdate: false,
      manualUpdateUrl: "https://docs.trae.cn/cli_get-started-with-trae-cli-2",
      notice: {
        en: "Run traecli update check, then traecli update using the original installation. Protocol verified with 0.213.1.",
        "zh-CN":
          "请在原安装中运行 traecli update check，再运行 traecli update。协议核对版本为 0.213.1。",
      },
    };
  };
}
