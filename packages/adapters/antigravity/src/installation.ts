import {
  createInstallationManager,
  fetchInstallationText,
  installationVersion,
  newerInstallationVersion,
  runInstallationCommand,
  versionFromOutput,
} from "@codexhost/harness-discovery";
import { resolveAntigravityExecutable } from "./command.js";

/** Manifest host embedded in the agy updater. */
const ANTIGRAVITY_UPDATE_MANIFEST_ROOT =
  "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app";

export interface AntigravityInstallationDependencies {
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  run?(args: readonly string[], timeout?: number): Promise<string>;
  fetchText?(url: string): Promise<string>;
}

/** Official updater manifest for this OS and CPU. agy publishes one file per target. */
export function antigravityUpdateManifestUrl(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string {
  const system =
    platform === "darwin"
      ? "darwin"
      : platform === "linux"
        ? "linux"
        : platform === "win32"
          ? "windows"
          : undefined;
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "amd64" : undefined;
  if (!system || !cpu) throw new Error("Antigravity updates are unavailable for this platform");
  return `${ANTIGRAVITY_UPDATE_MANIFEST_ROOT}/manifests/${system}_${cpu}.json`;
}

export function createAntigravityInstallation(
  environment: NodeJS.ProcessEnv,
  command?: string,
  dependencies: AntigravityInstallationDependencies = {},
) {
  const run =
    dependencies.run ??
    ((args: readonly string[], timeout?: number) =>
      runInstallationCommand(
        resolveAntigravityExecutable({ environment, ...(command ? { command } : {}) }) ?? "agy",
        args,
        environment,
        timeout,
      ));
  const fetchText = dependencies.fetchText ?? fetchInstallationText;
  const platform = dependencies.platform ?? process.platform;
  const arch = dependencies.arch ?? process.arch;
  return createInstallationManager({
    async check() {
      const manifestUrl = antigravityUpdateManifestUrl(platform, arch);
      const currentVersion = versionFromOutput(await run(["--version"]));
      let payload: { version?: unknown };
      try {
        payload = JSON.parse(await fetchText(manifestUrl)) as { version?: unknown };
      } catch (error) {
        if (error instanceof SyntaxError)
          throw new Error("Could not check the latest Antigravity version");
        throw error;
      }
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
