import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  resolveHarnessExecutable,
  runInstallationCommand,
  versionFromOutput,
  newerInstallationVersion,
  VERSION_MANAGER_ROOTS,
  type HarnessDiscoverySpec,
} from "@codexhost/harness-discovery";

const CODEX_DISCOVERY_SPEC: HarnessDiscoverySpec = {
  id: "codex",
  command: "codex",
  installRoots: {
    posix: ["~/.local/bin", VERSION_MANAGER_ROOTS, "/opt/homebrew/bin", "/usr/local/bin"],
    windows: ["${APPDATA}/npm", "~/.local/bin", VERSION_MANAGER_ROOTS],
  },
};

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isDesktopProxy(command: string, environment: NodeJS.ProcessEnv): boolean {
  const canonicalCommand = canonical(command);
  const proxyName = /codexhost|(?:^|[-_.])shim(?:[-_.]|$)/iu;
  if ([command, canonicalCommand].some((path) => proxyName.test(basename(path)))) return true;
  const routed = environment.CODEX_CLI_PATH;
  return typeof routed === "string" && routed !== "" && canonical(routed) === canonicalCommand;
}

/** Desktop discovery is supplied by the native launcher; PATH is the fallback. */
export async function resolveOfficialCodexExecutable(
  stockCodexPath: string,
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (stockCodexPath)
    return isDesktopProxy(stockCodexPath, environment) ? undefined : stockCodexPath;
  const resolution = resolveHarnessExecutable(CODEX_DISCOVERY_SPEC, { environment });
  if (!resolution) return undefined;
  const command = resolve(resolution.executable);
  if (isDesktopProxy(command, environment)) return undefined;
  try {
    const version = versionFromOutput(
      await runInstallationCommand(command, ["--version"], environment),
    );
    if (newerInstallationVersion(version, "0.161.0")) return undefined;
    return command;
  } catch {
    return undefined;
  }
}
