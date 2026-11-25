import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import {
  harnessCandidates,
  isExecutableFile,
  targetPath,
  runInstallationCommand,
  versionFromOutput,
  newerInstallationVersion,
  VERSION_MANAGER_ROOTS,
  type HarnessDiscoverySpec,
} from "@codexhost/harness-discovery";

/**
 * Windows npm installs launch Codex through a `.cmd` shim, which cannot spawn
 * the long-lived app-server directly (Node rejects `.cmd` without a shell).
 * The native binary lives inside the npm package: newer releases ship one
 * platform package per architecture, older ones bundled every binary in `bin`.
 */
const WINDOWS_NPM_CODEX_PACKAGES: ReadonlyArray<readonly [name: string, target: string]> = [
  ["@openai/codex-win32-x64", "x86_64-pc-windows-msvc"],
  ["@openai/codex-win32-arm64", "aarch64-pc-windows-msvc"],
];

function nativeWindowsNpmCodex(
  shimDirectory: string,
  isExecutable: (candidate: string) => boolean,
): string | undefined {
  const pathFlavor = targetPath("win32");
  const modulesDirectory = pathFlavor.join(shimDirectory, "node_modules");
  const dependencyDirectories = [
    pathFlavor.join(modulesDirectory, "@openai", "codex", "node_modules"),
    modulesDirectory,
  ];
  for (const [name, target] of WINDOWS_NPM_CODEX_PACKAGES) {
    for (const directory of dependencyDirectories) {
      const native = pathFlavor.join(
        directory,
        ...name.split("/"),
        "vendor",
        target,
        "bin",
        "codex.exe",
      );
      if (isExecutable(native)) return native;
    }
  }
  for (const [, target] of WINDOWS_NPM_CODEX_PACKAGES) {
    const bundled = pathFlavor.join(
      shimDirectory,
      "node_modules",
      "@openai",
      "codex",
      "bin",
      `codex-${target}.exe`,
    );
    if (isExecutable(bundled)) return bundled;
  }
  return undefined;
}

const CODEX_DISCOVERY_SPEC: HarnessDiscoverySpec = {
  id: "codex",
  command: "codex",
  installRoots: {
    posix: ["~/.local/bin", VERSION_MANAGER_ROOTS, "/opt/homebrew/bin", "/usr/local/bin"],
    windows: ["${APPDATA}/npm", "~/.local/bin", VERSION_MANAGER_ROOTS],
  },
  // Prefer the npm package's native codex.exe over the .cmd shim beside it:
  // the shim cannot start the app-server without a shell.
  runnableCandidate: (candidate, { platform, isExecutable }) => {
    const pathFlavor = targetPath(platform);
    if (platform !== "win32") return candidate;
    if (!/^codex\.(?:cmd|bat)$/iu.test(pathFlavor.basename(candidate))) return candidate;
    return nativeWindowsNpmCodex(pathFlavor.dirname(candidate), isExecutable);
  },
};

export { CODEX_DISCOVERY_SPEC };

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
  if (typeof routed === "string" && routed !== "" && canonical(routed) === canonicalCommand)
    return true;
  for (const candidate of [command, canonicalCommand]) {
    if (basename(candidate) !== "codex" || basename(dirname(candidate)) !== "bin") continue;
    try {
      const manifest = JSON.parse(
        readFileSync(resolve(dirname(candidate), "..", "manifest.json"), "utf8"),
      ) as { format?: unknown; wrapperPath?: unknown } | null;
      if (
        manifest?.format === 1 &&
        typeof manifest.wrapperPath === "string" &&
        canonical(manifest.wrapperPath) === canonicalCommand
      )
        return true;
    } catch {
      continue;
    }
  }
  return false;
}

/** Desktop discovery is supplied by the native launcher; PATH is the fallback. */
export async function resolveOfficialCodexExecutable(
  stockCodexPath: string,
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (stockCodexPath)
    return isDesktopProxy(stockCodexPath, environment) ? undefined : stockCodexPath;
  const platform = process.platform;
  const isExecutable = (candidate: string) => isExecutableFile(candidate, platform);
  const runnable = CODEX_DISCOVERY_SPEC.runnableCandidate ?? ((candidate: string) => candidate);
  const seen = new Set<string>();
  for (const { candidate } of harnessCandidates(CODEX_DISCOVERY_SPEC, { environment })) {
    const executable = runnable(candidate, { platform, isExecutable });
    if (executable === undefined) continue;
    const command = resolve(executable);
    if (seen.has(command)) continue;
    seen.add(command);
    if (!isExecutable(command) || isDesktopProxy(command, environment)) continue;
    try {
      const version = versionFromOutput(
        await runInstallationCommand(command, ["--version"], environment),
      );
      if (newerInstallationVersion(version, "0.161.0")) continue;
      return command;
    } catch {
      continue;
    }
  }
  return undefined;
}
