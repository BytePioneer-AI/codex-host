import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import type {
  CommonUpdateOptions,
  MacOsDmgUpdateOptions,
  NpmUpdateOptions,
  WindowsInstallerUpdateOptions,
} from "./update-manager.js";
import { parseDistributionMetadata, type DistributionMetadata } from "./distribution-metadata.js";
import {
  sameWindowsPath,
  validateWindowsInstallerInstallation,
  validateWindowsNpmInstallation,
} from "./windows-installation.js";
export { parseDistributionMetadata, type DistributionMetadata } from "./distribution-metadata.js";
import type { ReleaseTarget } from "./github-release.js";
import type { UpdateResultScope } from "./update-result.js";

export function installedUpdateResultScope(context: InstalledUpdateContext): UpdateResultScope {
  const i = context.installation;
  return {
    installation: i.kind,
    installationRoot:
      i.kind === "npm"
        ? path.resolve(path.dirname(i.options.npmLauncherPath), "../../../..")
        : i.kind === "windows-installer"
          ? i.options.installRoot
          : i.options.appPath,
    runtimeDescriptorPath: context.common.runtimeDescriptorPath,
    launcherPid: context.common.launcherPid,
    ...(context.common.launcherStartedAtMicros
      ? { launcherStartedAtMicros: context.common.launcherStartedAtMicros }
      : {}),
    version: context.metadata.version,
  };
}

export const UPDATE_RUNTIME_ENV = Object.freeze({
  launcherPid: "CODEXHOST_LAUNCHER_PID",
  launcherStartedAtMicros: "CODEXHOST_LAUNCHER_STARTED_AT_MICROS",
  launcherExecutable: "CODEXHOST_LAUNCHER_EXECUTABLE",
  runtimeDescriptorPath: "CODEXHOST_RUNTIME_DESCRIPTOR_PATH",
  controllerPort: "CODEXHOST_CONTROL_PORT",
  controllerNonce: "CODEXHOST_CONTROL_NONCE",
  npmNodePath: "CODEXHOST_NPM_NODE_PATH",
  npmCliPath: "CODEXHOST_NPM_CLI_PATH",
  npmLauncherPath: "CODEXHOST_NPM_LAUNCHER_PATH",
  npmPackageRoot: "CODEXHOST_NPM_PACKAGE_ROOT",
});

export interface InstalledUpdateContext {
  metadata: DistributionMetadata;
  common: CommonUpdateOptions;
  controller: { port: number; nonce: string };
  installation:
    | { kind: "npm"; options: NpmUpdateOptions }
    | { kind: "windows-installer"; options: Omit<WindowsInstallerUpdateOptions, "artifact"> }
    | { kind: "macos-dmg"; options: Omit<MacOsDmgUpdateOptions, "artifact"> };
}

interface ResolveInstalledUpdateContextOptions {
  hostRuntimePath: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  architecture?: string;
  stateDirectory?: string;
}

function absoluteEnvironmentPath(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return path.normalize(value);
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
  const launcherStartedAtMicros = environment[UPDATE_RUNTIME_ENV.launcherStartedAtMicros];
  if (
    platform === "win32" &&
    (!launcherStartedAtMicros ||
      !/^[1-9][0-9]{0,19}$/u.test(launcherStartedAtMicros) ||
      BigInt(launcherStartedAtMicros) > 18446744073709551615n)
  ) {
    throw new Error("Windows Launcher creation time is unavailable or invalid");
  }
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
  const common = {
    version: metadata.version,
    ...(platform === "win32"
      ? {
          installedVersion: metadata.version,
          launcherStartedAtMicros: launcherStartedAtMicros as string,
        }
      : {}),
    launcherPid,
    launcherExecutable,
    runtimeDescriptorPath,
    updaterExecutable,
    stateDirectory,
  };
  const controller = {
    port: positiveEnvironmentInteger(environment, UPDATE_RUNTIME_ENV.controllerPort),
    nonce: environment[UPDATE_RUNTIME_ENV.controllerNonce] ?? "",
  };
  if (!/^[0-9a-f]{32}$/u.test(controller.nonce)) {
    throw new Error(`${UPDATE_RUNTIME_ENV.controllerNonce} must be a lowercase nonce`);
  }

  if (metadata.distribution === "npm") {
    const npmOptions = {
      ...common,
      nodePath: absoluteEnvironmentPath(environment, UPDATE_RUNTIME_ENV.npmNodePath),
      npmCliPath: absoluteEnvironmentPath(environment, UPDATE_RUNTIME_ENV.npmCliPath),
      npmLauncherPath: absoluteEnvironmentPath(environment, UPDATE_RUNTIME_ENV.npmLauncherPath),
      packageRoot: absoluteEnvironmentPath(environment, UPDATE_RUNTIME_ENV.npmPackageRoot),
    };
    if (
      platform === "win32"
        ? !sameWindowsPath(npmOptions.packageRoot, resourcesRoot)
        : path.normalize(npmOptions.packageRoot) !== resourcesRoot
    ) {
      throw new Error("npm platform package root does not own the Host Runtime");
    }
    if (platform === "win32") await validateWindowsNpmInstallation(npmOptions, architecture);
    return { metadata, common, controller, installation: { kind: "npm", options: npmOptions } };
  }
  if (platform === "win32") {
    await validateWindowsInstallerInstallation(
      installationRoot,
      launcherExecutable,
      architecture,
      metadata.version,
    );
    return {
      metadata,
      common,
      controller,
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
      controller,
      installation: {
        kind: "macos-dmg",
        options: { ...common, appPath: installationRoot },
      },
    };
  }
  throw new Error("installer updates require Windows or macOS");
}
