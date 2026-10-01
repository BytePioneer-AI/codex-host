import {
  createInstallationManager,
  newerInstallationVersion,
  npmInstallation,
  runInstallationCommand,
  versionFromOutput,
} from "@codexhost/harness-discovery";
import { resolveDeepSeekCommand } from "./executable.js";

export function createDeepSeekInstallation(environment: NodeJS.ProcessEnv, command?: string) {
  let update: ((version: string) => Promise<void>) | undefined;
  return createInstallationManager({
    async check() {
      const invocation = resolveDeepSeekCommand(command, environment);
      if (!invocation) throw new Error("DeepSeek Harness is not installed");
      const currentVersion = versionFromOutput(
        await runInstallationCommand(
          invocation.command,
          [...invocation.arguments, "--version"],
          environment,
        ),
      );
      // An offline npx cache, desktop carrier, or Python wheel is not a global npm install.
      const npm =
        invocation.kind === "npx"
          ? null
          : await npmInstallation(invocation.command, ["@deepseek-ai/dsh"], environment);
      update = npm?.update;
      const latestVersion = npm ? await npm.latest() : "Unknown";
      const canUpdate = npm?.canUpdate ?? false;
      return {
        currentVersion,
        latestVersion,
        updateAvailable: !!npm && newerInstallationVersion(currentVersion, latestVersion),
        canUpdate,
        ...(!canUpdate
          ? {
              message:
                "Update with the original installer. Offline npx, Python, desktop, and project-local installations are not upgraded through global npm.",
            }
          : {}),
      };
    },
    async update(state) {
      if (!update) throw new Error("This DeepSeek installation requires a manual update");
      await update(state.latestVersion);
    },
  });
}
