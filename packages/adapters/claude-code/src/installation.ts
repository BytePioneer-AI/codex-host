import { readFile, realpath } from "node:fs/promises";
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
import { resolveClaudeCodeExecutable } from "./command.js";

type UpdateSettings = {
  autoUpdatesChannel?: string;
  minimumVersion?: string;
  requiredMaximumVersion?: string;
  env?: Record<string, string>;
};

async function readSettings(file: string): Promise<UpdateSettings> {
  const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "{}";
    throw error;
  });
  const settings: unknown = JSON.parse(text);
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    throw new Error("Claude update settings are invalid");
  return settings as UpdateSettings;
}

export function createClaudeInstallation(environment: NodeJS.ProcessEnv, command?: string) {
  let update: () => Promise<void>;
  return createInstallationManager({
    async check() {
      const executable = resolveClaudeCodeExecutable({
        environment,
        ...(command ? { command } : {}),
      });
      const home = environment.HOME ?? environment.USERPROFILE ?? homedir();
      const config = environment.CLAUDE_CONFIG_DIR
        ? path.resolve(home, environment.CLAUDE_CONFIG_DIR)
        : path.join(home, ".claude");
      const managedFile =
        process.platform === "darwin"
          ? "/Library/Application Support/ClaudeCode/managed-settings.json"
          : process.platform === "win32"
            ? path.join(
                environment.ProgramFiles ?? "C:\\Program Files",
                "ClaudeCode",
                "managed-settings.json",
              )
            : "/etc/claude-code/managed-settings.json";
      const user = await readSettings(path.join(config, "settings.json"));
      const managed = await readSettings(managedFile);
      const settings = { ...user, ...managed, env: { ...user.env, ...managed.env } };
      const env = { ...environment, ...settings.env };
      const currentVersion = versionFromOutput(
        await runInstallationCommand(executable, ["--version"], {
          ...env,
          DISABLE_AUTOUPDATER: "1",
        }),
      );
      const channel = settings.autoUpdatesChannel ?? "latest";
      if (channel !== "latest" && channel !== "stable")
        throw new Error("Unknown Claude release channel");
      const latestVersion = installationVersion(
        await fetchInstallationText(`https://downloads.claude.ai/claude-code-releases/${channel}`),
      );
      const npm = await npmInstallation(executable, ["@anthropic-ai/claude-code"], env);
      const launcher = path.join(
        home,
        ".local",
        "bin",
        process.platform === "win32" ? "claude.exe" : "claude",
      );
      const selected = await realpath(executable);
      const versions = path.join(home, ".local", "share", "claude", "versions") + path.sep;
      const native =
        path.resolve(executable) === launcher &&
        (selected.startsWith(versions) || (process.platform === "win32" && selected === launcher));
      const blocked =
        (!!env.DISABLE_UPDATES && env.DISABLE_UPDATES !== "0") ||
        (!!settings.minimumVersion &&
          newerInstallationVersion(latestVersion, installationVersion(settings.minimumVersion))) ||
        (!!settings.requiredMaximumVersion &&
          newerInstallationVersion(
            installationVersion(settings.requiredMaximumVersion),
            latestVersion,
          ));
      const canUpdate = !blocked && (npm?.canUpdate ?? native);
      update = async () => {
        // Keep native policy enforcement, but pin npm's target to this installation's prefix.
        const updateEnv = npm
          ? { ...env, npm_config_prefix: npm.prefix, NPM_CONFIG_PREFIX: npm.prefix }
          : env;
        await runInstallationCommand(executable, ["update"], updateEnv, 300_000);
      };
      return {
        currentVersion,
        latestVersion,
        updateAvailable: newerInstallationVersion(currentVersion, latestVersion),
        canUpdate,
        ...(!canUpdate
          ? {
              messageCode: blocked ? "claude-policy-restricted" : "original-installer",
              message: blocked
                ? "Claude updates are restricted by the installation's settings or policy."
                : "Use the original installer or package manager for this Claude installation.",
            }
          : {}),
      };
    },
    async update() {
      await update();
    },
  });
}
