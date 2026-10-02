import {
  createInstallationManager,
  newerInstallationVersion,
  npmInstallation,
  resolveHarnessExecutable,
  runInstallationCommand,
  versionFromOutput,
} from "@codexhost/harness-discovery";
import { codeBuddyDiscoverySpec } from "./command.js";

export function createCodeBuddyInstallation(environment: NodeJS.ProcessEnv) {
  let update: ((version: string) => Promise<void>) | undefined;
  return createInstallationManager({
    async check() {
      const resolved = resolveHarnessExecutable(codeBuddyDiscoverySpec, { environment });
      if (!resolved) throw new Error("CodeBuddy is not installed");
      const currentVersion = versionFromOutput(
        await runInstallationCommand(resolved.executable, ["--version"], environment),
      );
      const npm = await npmInstallation(
        resolved.executable,
        ["@tencent-ai/codebuddy-code"],
        environment,
      );
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
              messageCode: "codebuddy-npm-required",
              message:
                "Use CodeBuddy's native updater or original package manager for this installation. Latest-version checks here require an identified npm installation.",
            }
          : {}),
      };
    },
    async update(state) {
      if (!update) throw new Error("This CodeBuddy installation requires a manual update");
      await update(state.latestVersion);
    },
  });
}
