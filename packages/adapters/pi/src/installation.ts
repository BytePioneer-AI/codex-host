import {
  createInstallationManager,
  fetchInstallationText,
  installationVersion,
  newerInstallationVersion,
  runInstallationCommand,
  versionFromOutput,
} from "@codexhost/harness-discovery";
import { resolvePiExecutable } from "./command.js";

/** The endpoint `pi update` uses. Not the npm registry. */
const PI_LATEST_VERSION_URL = "https://pi.dev/api/latest-version";

export function createPiInstallation(environment: NodeJS.ProcessEnv, command?: string) {
  const run = (args: string[], timeout?: number) =>
    runInstallationCommand(
      resolvePiExecutable({ environment, ...(command ? { command } : {}) }),
      args,
      environment,
      timeout,
    );
  return createInstallationManager({
    async check() {
      const currentVersion = versionFromOutput(await run(["--version"]));
      const payload = JSON.parse(await fetchInstallationText(PI_LATEST_VERSION_URL)) as {
        version?: unknown;
      };
      const latestVersion = installationVersion(payload.version);
      return {
        currentVersion,
        latestVersion,
        updateAvailable: newerInstallationVersion(currentVersion, latestVersion),
        canUpdate: true,
      };
    },
    async update() {
      await run(["update"], 300_000);
    },
  });
}
