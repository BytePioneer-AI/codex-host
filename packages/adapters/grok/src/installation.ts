import {
  createInstallationManager,
  installationVersion,
  readLauncherScript,
  runInstallationCommand,
  versionFromOutput,
} from "@codexhost/harness-discovery";
import { resolveGrokExecutable } from "./command.js";

const GROK_NPM_PACKAGE = "@xai-official/grok";

export function createGrokInstallation(environment: NodeJS.ProcessEnv, command?: string) {
  const run = (args: string[], timeout?: number, extra?: NodeJS.ProcessEnv) =>
    runInstallationCommand(
      resolveGrokExecutable({ environment, ...(command ? { command } : {}) }),
      args,
      extra ? { ...environment, ...extra } : environment,
      timeout,
    );
  let installer = "";
  return createInstallationManager({
    async check() {
      const launcher = await readLauncherScript(
        resolveGrokExecutable({ environment, ...(command ? { command } : {}) }),
      );
      if (launcher.includes("GROKGOD_HOME=") && launcher.includes("GROKGOD_BIN=")) {
        return {
          currentVersion: versionFromOutput(
            await run(["--version"], undefined, {
              GROK_DISABLE_AUTOUPDATER: "1",
              GROKGOD_UPDATE_CHECK_DISABLE: "1",
            }),
          ),
          latestVersion: "Unknown",
          latestVersionKind: "unknown" as const,
          updateAvailable: false,
          canUpdate: false,
          messageCode: "original-installer",
          notice: {
            en: "Managed by grokgod. Use grokgod's updater or installer to preserve the installed patches. The latest patched version is not checked here.",
            "zh-CN":
              "此安装由 grokgod 管理。请使用 grokgod 的更新程序或安装程序保留补丁；此处不检查最新补丁版本。",
          },
        };
      }
      const state = JSON.parse(await run(["update", "--check", "--json"])) as Record<
        string,
        unknown
      >;
      if (state.error || typeof state.updateAvailable !== "boolean")
        throw new Error("Grok update check failed");
      installer = typeof state.installer === "string" ? state.installer : "";
      return {
        currentVersion: installationVersion(state.currentVersion),
        latestVersion: installationVersion(state.latestVersion),
        updateAvailable: state.updateAvailable,
        canUpdate: true,
      };
    },
    async update() {
      // npm 12 skips this package's postinstall unless it is allow-listed.
      // That script is what replaces ~/.grok/bin/grok.
      if (installer !== "npm") {
        await run(["update"], 300_000);
        return;
      }
      const existing = environment.npm_config_allow_scripts?.trim();
      const allowed = existing ? `${existing},${GROK_NPM_PACKAGE}` : GROK_NPM_PACKAGE;
      await run(["update", "--force-reinstall"], 300_000, {
        npm_config_allow_scripts: allowed,
      });
    },
  });
}
