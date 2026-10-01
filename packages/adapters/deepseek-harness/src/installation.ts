import {
  createInstallationManager,
  fetchInstallationText,
  installationVersion,
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
      // Version discovery is independent of whether this installation can be updated.
      const metadata = JSON.parse(
        await fetchInstallationText("https://registry.npmjs.org/%40deepseek-ai%2Fdsh/latest"),
      ) as { version?: unknown };
      const latestVersion = installationVersion(metadata.version);
      const isNpx = invocation.kind === "npx";
      const npm = isNpx
        ? null
        : await npmInstallation(invocation.command, ["@deepseek-ai/dsh"], environment);
      update = isNpx
        ? async (version) => {
            // Keep the same unversioned package spec as resolveDeepSeekCommand:
            // npm keys its npx cache by package spec, so @latest or @<version>
            // would populate a different cache instead of updating our launch path.
            const output = await runInstallationCommand(
              invocation.command,
              ["--yes", "--prefer-online", "@deepseek-ai/dsh", "--version"],
              environment,
              600_000,
            );
            if (versionFromOutput(output) !== version)
              throw new Error("DSH npx update did not select the requested version");
            // Verify the exact offline invocation used by subsequent Host launches.
            const offline = await runInstallationCommand(
              invocation.command,
              [...invocation.arguments, "--version"],
              environment,
            );
            if (versionFromOutput(offline) !== version)
              throw new Error("DSH offline npx launch still selects a different version");
          }
        : npm?.update;
      const canUpdate = isNpx || (npm?.canUpdate ?? false);
      return {
        currentVersion,
        latestVersion,
        updateAvailable: newerInstallationVersion(currentVersion, latestVersion),
        canUpdate,
        ...(!canUpdate
          ? {
              message:
                "Update with the original installer. Python, desktop, and project-local installations are not upgraded through global npm.",
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
