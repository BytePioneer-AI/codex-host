import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import type {
  CommonUpdateOptions,
  LinuxArchiveUpdateOptions,
  MacOsDmgUpdateOptions,
  NpmUpdateOptions,
  WindowsInstallerUpdateOptions,
} from "./update-manager.js";
import { requireSemanticVersion } from "./status.js";
import type { ReleaseTarget } from "./github-release.js";

const PLATFORM_PACKAGE_PATTERN = /^cli-[a-z0-9-]+$/u;

export const UPDATE_RUNTIME_ENV = Object.freeze({
  launcherPid: "CODEXHOST_LAUNCHER_PID",
  launcherExecutable: "CODEXHOST_LAUNCHER_EXECUTABLE",
  runtimeDescriptorPath: "CODEXHOST_RUNTIME_DESCRIPTOR_PATH",
  controllerPort: "CODEXHOST_CONTROL_PORT",
  controllerNonce: "CODEXHOST_CONTROL_NONCE",
  npmNodePath: "CODEXHOST_NPM_NODE_PATH",
  npmCliPath: "CODEXHOST_NPM_CLI_PATH",
  npmLauncherPath: "CODEXHOST_NPM_LAUNCHER_PATH",
  npmPackageRoot: "CODEXHOST_NPM_PACKAGE_ROOT",
  serviceManaged: "CODEXHOST_UPDATE_SERVICE",
});

export interface DistributionMetadata {
  schemaVersion: 1;
  version: string;
  distribution: "npm" | "installer";
  target: ReleaseTarget;
}

export interface NpmRuntimePaths {
  nodePath: string;
  npmCliPath: string;
  npmLauncherPath: string;
  packageRoot: string;
}

export interface ResolveNpmRuntimePathsOptions {
  packageRoot: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  nodeExecutable?: string;
}

export interface InstalledUpdateContext {
  metadata: DistributionMetadata;
  common: CommonUpdateOptions;
  installation:
    | { kind: "npm"; options: NpmUpdateOptions }
    | { kind: "windows-installer"; options: Omit<WindowsInstallerUpdateOptions, "artifact"> }
    | { kind: "macos-dmg"; options: Omit<MacOsDmgUpdateOptions, "artifact"> }
    | { kind: "linux-archive"; options: Omit<LinuxArchiveUpdateOptions, "artifact"> };
}

interface ResolveInstalledUpdateContextOptions {
  hostRuntimePath: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  architecture?: string;
  stateDirectory?: string;
  nodeExecutable?: string;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function parseDistributionMetadata(value: unknown): DistributionMetadata {
  const metadata = object(value, "distribution metadata");
  const allowed = ["distribution", "schemaVersion", "target", "version"];
  if (Object.keys(metadata).some((key) => !allowed.includes(key))) {
    throw new Error("distribution metadata contains unknown fields");
  }
  if (
    metadata.schemaVersion !== 1 ||
    (metadata.distribution !== "npm" && metadata.distribution !== "installer") ||
    ![
      "macos-arm64",
      "macos-x64",
      "windows-x64",
      "windows-arm64",
      "linux-x64",
      "linux-arm64",
    ].includes(String(metadata.target)) ||
    typeof metadata.version !== "string"
  ) {
    throw new Error("distribution metadata is invalid");
  }
  return {
    schemaVersion: 1,
    version: requireSemanticVersion(metadata.version),
    distribution: metadata.distribution,
    target: metadata.target as ReleaseTarget,
  };
}

function absoluteEnvironmentPath(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return path.normalize(value);
}

function explicitAbsoluteEnvironmentPath(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const value = environment[name];
  if (value === undefined) return undefined;
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return path.normalize(value);
}

function npmPackageLayout(
  packageRoot: string,
): { launcherCandidate: string; globalModulesRoot: string } | null {
  const scopeDirectory = path.dirname(packageRoot);
  if (
    path.basename(scopeDirectory) !== "@codexhost" ||
    !PLATFORM_PACKAGE_PATTERN.test(path.basename(packageRoot))
  ) {
    return null;
  }
  const parentModules = path.dirname(scopeDirectory);
  const cliPackage = path.dirname(parentModules);
  const outerScope = path.dirname(cliPackage);
  if (
    path.basename(parentModules) === "node_modules" &&
    path.basename(cliPackage) === "cli" &&
    path.basename(outerScope) === "@codexhost"
  ) {
    return {
      launcherCandidate: path.join(cliPackage, "bin", "codexhost.js"),
      globalModulesRoot: path.dirname(outerScope),
    };
  }
  return {
    launcherCandidate: path.resolve(packageRoot, "../cli/bin/codexhost.js"),
    globalModulesRoot: parentModules,
  };
}

async function resolveRegularFile(candidate: string): Promise<string | null> {
  if (!candidate || !path.isAbsolute(candidate)) return null;
  try {
    const resolved = await realpath(candidate);
    const metadata = await lstat(resolved);
    return metadata.isFile() && !metadata.isSymbolicLink() ? resolved : null;
  } catch {
    return null;
  }
}

async function firstRegularFile(
  candidates: readonly string[],
  predicate?: (resolved: string) => boolean,
): Promise<string | null> {
  for (const candidate of candidates) {
    const resolved = await resolveRegularFile(candidate);
    if (resolved && (!predicate || predicate(resolved))) return resolved;
  }
  return null;
}

function discoverNpmNodePath(
  globalModulesRoot: string,
  platform: NodeJS.Platform,
  nodeExecutable: string,
): Promise<string | null> {
  const candidates: string[] = [];
  if (path.basename(globalModulesRoot) === "node_modules") {
    const modulesParent = path.dirname(globalModulesRoot);
    if (platform === "win32") {
      candidates.push(path.join(modulesParent, "node.exe"));
    } else if (path.basename(modulesParent) === "lib") {
      candidates.push(path.join(path.dirname(modulesParent), "bin", "node"));
    }
  }
  candidates.push(nodeExecutable);
  return firstRegularFile(candidates);
}

function homebrewNpmCliCandidates(nodePath: string, environment: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = [];
  const segments = nodePath.split(path.sep);
  const cellarIndex = segments.lastIndexOf("Cellar");
  if (
    cellarIndex >= 1 &&
    segments[cellarIndex + 1]?.startsWith("node") &&
    segments.at(-2) === "bin" &&
    segments.at(-1) === "node"
  ) {
    const brewPrefix = segments.slice(0, cellarIndex).join(path.sep);
    candidates.push(
      path.join(brewPrefix, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
      path.join(
        path.dirname(path.dirname(nodePath)),
        "libexec",
        "lib",
        "node_modules",
        "npm",
        "bin",
        "npm-cli.js",
      ),
    );
  }
  if (environment.HOMEBREW_PREFIX && path.isAbsolute(environment.HOMEBREW_PREFIX)) {
    candidates.push(
      path.join(environment.HOMEBREW_PREFIX, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    );
  }
  return candidates;
}

async function discoverNpmCliPath(
  globalModulesRoot: string,
  nodePath: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<string | null> {
  const candidates: string[] = [];
  if (path.basename(globalModulesRoot) === "node_modules") {
    candidates.push(path.join(globalModulesRoot, "npm", "bin", "npm-cli.js"));
  }
  candidates.push(
    platform === "win32"
      ? path.join(path.dirname(nodePath), "node_modules", "npm", "bin", "npm-cli.js")
      : path.join(
          path.dirname(path.dirname(nodePath)),
          "lib",
          "node_modules",
          "npm",
          "bin",
          "npm-cli.js",
        ),
  );
  if (platform !== "win32") {
    candidates.push(...homebrewNpmCliCandidates(nodePath, environment));
  }
  if (environment.npm_execpath) {
    candidates.push(environment.npm_execpath);
  }
  for (const directory of (environment.PATH ?? environment.Path ?? "").split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    if (platform === "win32") {
      candidates.push(path.join(directory, "node_modules", "npm", "bin", "npm-cli.js"));
      const shim = await resolveRegularFile(path.join(directory, "npm.cmd"));
      if (shim && path.dirname(shim) !== directory) {
        candidates.push(path.join(path.dirname(shim), "node_modules", "npm", "bin", "npm-cli.js"));
      }
    } else {
      candidates.push(path.join(directory, "npm"));
    }
  }
  return firstRegularFile(candidates, (resolved) => {
    const name = path.basename(resolved);
    return (platform === "win32" ? name.toLowerCase() : name) === "npm-cli.js";
  });
}

function ordinaryWindowsPath(value: string): string {
  return value.replace(/^\\\\\?\\UNC\\/iu, "\\\\").replace(/^\\\\\?\\(?=[a-z]:[\\/])/iu, "");
}

async function canonicalWindowsNpmPackageRoot(root: string): Promise<string> {
  const ordinaryPath = ordinaryWindowsPath(root);
  const metadata = await lstat(ordinaryPath);
  if (metadata.isSymbolicLink()) {
    throw new Error("The npm platform package is a link or junction; update it manually with npm");
  }
  return realpath(ordinaryPath);
}

/**
 * Resolves the npm update runtime paths from explicit `CODEXHOST_NPM_*` variables,
 * falling back to the installed `@codexhost/cli-*` global layout only for variables
 * that are unset. Explicitly provided invalid values are always rejected.
 */
export async function resolveNpmRuntimePaths(
  options: ResolveNpmRuntimePathsOptions,
): Promise<NpmRuntimePaths> {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  if (!path.isAbsolute(options.packageRoot)) {
    throw new Error("npm platform package root must be an absolute path");
  }
  const resourcesRoot = path.normalize(options.packageRoot);
  const explicitNodePath = explicitAbsoluteEnvironmentPath(
    environment,
    UPDATE_RUNTIME_ENV.npmNodePath,
  );
  const explicitNpmCliPath = explicitAbsoluteEnvironmentPath(
    environment,
    UPDATE_RUNTIME_ENV.npmCliPath,
  );
  const explicitLauncherPath = explicitAbsoluteEnvironmentPath(
    environment,
    UPDATE_RUNTIME_ENV.npmLauncherPath,
  );
  const explicitPackageRoot = explicitAbsoluteEnvironmentPath(
    environment,
    UPDATE_RUNTIME_ENV.npmPackageRoot,
  );
  const windows = platform === "win32" && process.platform === "win32";
  const ordinaryPackageRoot = windows ? ordinaryWindowsPath(resourcesRoot) : resourcesRoot;
  const canonicalPackageRoot = windows
    ? await canonicalWindowsNpmPackageRoot(resourcesRoot)
    : resourcesRoot;
  const canonicalConfiguredRoot =
    windows && explicitPackageRoot !== undefined
      ? await canonicalWindowsNpmPackageRoot(explicitPackageRoot)
      : explicitPackageRoot;
  if (canonicalConfiguredRoot !== undefined && canonicalConfiguredRoot !== canonicalPackageRoot) {
    throw new Error("npm platform package root does not own the Host Runtime");
  }
  if (
    explicitNodePath !== undefined &&
    explicitNpmCliPath !== undefined &&
    explicitLauncherPath !== undefined &&
    explicitPackageRoot !== undefined
  ) {
    return {
      nodePath: explicitNodePath,
      npmCliPath: explicitNpmCliPath,
      npmLauncherPath: explicitLauncherPath,
      packageRoot: ordinaryPackageRoot,
    };
  }
  const packageRoot = canonicalPackageRoot;
  const layout = npmPackageLayout(packageRoot);
  if (!layout) {
    if (explicitNodePath === undefined) {
      throw new Error(`${UPDATE_RUNTIME_ENV.npmNodePath} must be an absolute path`);
    }
    if (explicitNpmCliPath === undefined) {
      throw new Error(`${UPDATE_RUNTIME_ENV.npmCliPath} must be an absolute path`);
    }
    if (explicitLauncherPath === undefined) {
      throw new Error(`${UPDATE_RUNTIME_ENV.npmLauncherPath} must be an absolute path`);
    }
    throw new Error(`${UPDATE_RUNTIME_ENV.npmPackageRoot} must be an absolute path`);
  }
  const nodePath =
    explicitNodePath ??
    (await discoverNpmNodePath(
      layout.globalModulesRoot,
      platform,
      options.nodeExecutable ?? process.execPath,
    ));
  if (!nodePath) {
    throw new Error(`${UPDATE_RUNTIME_ENV.npmNodePath} must be an absolute path`);
  }
  const npmCliPath =
    explicitNpmCliPath ??
    (await discoverNpmCliPath(layout.globalModulesRoot, nodePath, environment, platform));
  if (!npmCliPath) {
    throw new Error(
      platform === "win32"
        ? "Cannot find npm-cli.js beside Node.js or npm.cmd; reinstall npm or set CODEXHOST_NPM_CLI_PATH to npm-cli.js"
        : `${UPDATE_RUNTIME_ENV.npmCliPath} must be an absolute path`,
    );
  }
  const npmLauncherPath =
    explicitLauncherPath ?? (await resolveRegularFile(layout.launcherCandidate));
  if (!npmLauncherPath) {
    throw new Error(`${UPDATE_RUNTIME_ENV.npmLauncherPath} must be an absolute path`);
  }
  return { nodePath, npmCliPath, npmLauncherPath, packageRoot };
}

function positiveEnvironmentInteger(environment: NodeJS.ProcessEnv, name: string): number {
  const value = Number(environment[name]);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

function expectedTarget(platform: NodeJS.Platform, architecture: string): ReleaseTarget {
  if (platform === "darwin" && architecture === "arm64") return "macos-arm64";
  if (platform === "darwin" && architecture === "x64") return "macos-x64";
  if (platform === "win32" && architecture === "arm64") return "windows-arm64";
  if (platform === "win32" && architecture === "x64") return "windows-x64";
  if (platform === "linux" && architecture === "x64") return "linux-x64";
  if (platform === "linux" && architecture === "arm64") return "linux-arm64";
  throw new Error(`unsupported update host ${platform}/${architecture}`);
}

export function defaultUpdateStateDirectory(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "win32") {
    const root = environment.LOCALAPPDATA;
    if (!root || !path.isAbsolute(root)) throw new Error("LOCALAPPDATA is unavailable");
    return path.join(root, "codexhost", "updates");
  }
  const home = environment.HOME;
  if (!home || !path.isAbsolute(home)) throw new Error("HOME is unavailable");
  return platform === "darwin"
    ? path.join(home, "Library", "Application Support", "codexhost", "updates")
    : path.join(home, ".codexhost", "updates");
}

export async function resolveInstalledUpdateContext(
  options: ResolveInstalledUpdateContextOptions,
): Promise<InstalledUpdateContext> {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  if (!path.isAbsolute(options.hostRuntimePath)) {
    throw new Error("Host Runtime path must be absolute");
  }
  const hostRuntimePath = path.normalize(options.hostRuntimePath);
  const runtimeMetadata = await lstat(hostRuntimePath);
  if (!runtimeMetadata.isFile() || runtimeMetadata.isSymbolicLink()) {
    throw new Error("Host Runtime must be a regular file");
  }
  const appDirectory = path.dirname(hostRuntimePath);
  const metadata = parseDistributionMetadata(
    JSON.parse(await readFile(path.join(appDirectory, "codexhost-distribution.json"), "utf8")),
  );
  const target = expectedTarget(platform, architecture);
  if (metadata.target !== target) {
    throw new Error(`installed target ${metadata.target} does not match ${target}`);
  }
  const launcherPid = positiveEnvironmentInteger(environment, UPDATE_RUNTIME_ENV.launcherPid);
  const launcherExecutable = absoluteEnvironmentPath(
    environment,
    UPDATE_RUNTIME_ENV.launcherExecutable,
  );
  const runtimeDescriptorPath = absoluteEnvironmentPath(
    environment,
    UPDATE_RUNTIME_ENV.runtimeDescriptorPath,
  );
  const stateDirectory = path.normalize(
    options.stateDirectory ?? defaultUpdateStateDirectory(platform, environment),
  );
  const resourcesRoot = path.dirname(appDirectory);
  const installationRoot =
    platform === "darwin" ? path.dirname(path.dirname(resourcesRoot)) : resourcesRoot;
  const updaterExecutable = path.join(
    resourcesRoot,
    "libexec",
    platform === "win32" ? "codexhost-updater.exe" : "codexhost-updater",
  );
  const serviceManaged = environment[UPDATE_RUNTIME_ENV.serviceManaged] === "1";
  const common: CommonUpdateOptions = {
    version: metadata.version,
    launcherPid,
    launcherExecutable,
    runtimeDescriptorPath,
    updaterExecutable,
    stateDirectory,
    ...(serviceManaged
      ? {
          serviceManaged: true,
          restartTarget: "web" as const,
          dataDirectory: absoluteEnvironmentPath(environment, "CODEXHOST_DATA_DIR"),
        }
      : {}),
  };

  if (metadata.distribution === "npm") {
    const npmPaths = await resolveNpmRuntimePaths({
      packageRoot: resourcesRoot,
      environment,
      platform,
      ...(options.nodeExecutable === undefined ? {} : { nodeExecutable: options.nodeExecutable }),
    });
    return {
      metadata,
      common,
      installation: { kind: "npm", options: { ...common, ...npmPaths } },
    };
  }
  if (platform === "win32") {
    return {
      metadata,
      common,
      installation: {
        kind: "windows-installer",
        options: { ...common, installRoot: installationRoot },
      },
    };
  }
  if (platform === "darwin") {
    return {
      metadata,
      common,
      installation: {
        kind: "macos-dmg",
        options: { ...common, appPath: installationRoot },
      },
    };
  }
  if (platform === "linux") {
    return {
      metadata,
      common,
      installation: {
        kind: "linux-archive",
        options: { ...common, installRoot: installationRoot },
      },
    };
  }
  throw new Error("installer updates require Windows, macOS, or Linux");
}
