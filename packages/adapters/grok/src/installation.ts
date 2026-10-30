import {
  createInstallationManager,
  installationVersion,
  runInstallationCommand,
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
