import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { CodeBuddyError, type CodeBuddyInvocationFactory } from "@codexhost/adapter-codebuddy";
import {
  commandInvocation,
  environmentValue,
  isExecutableFile,
  isDirectory,
  resolveHarnessExecutable,
  targetPath,
  withNodeRuntimeOnPath,
  type HarnessDiscoverySpec,
} from "@codexhost/harness-discovery";
import { workBuddyDelegationArguments } from "./delegation.js";
import {
  resolveWorkBuddyBundle,
  resolveWorkBuddyInstallDirectory,
  WORKBUDDY_MACOS_ELECTRON,
} from "./discovery.js";
export { WORKBUDDY_MACOS_ELECTRON, WORKBUDDY_MACOS_CLI } from "./discovery.js";

export const workBuddyDiscoverySpec: HarnessDiscoverySpec = {
  id: "workbuddy",
  // An absolute app-owned default deliberately prevents discovery of an unrelated PATH codebuddy.
  command: WORKBUDDY_MACOS_ELECTRON,
  commandEnvironmentVariable: "CODEXHOST_WORKBUDDY_COMMAND",
};

interface WorkBuddyInvocationDependencies {
  platform?: NodeJS.Platform;
  isExecutable?: (candidate: string) => boolean;
  isDirectory?: (candidate: string) => boolean;
  lstat?: (candidate: string) => {
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
    mode: number;
    size: number;
    uid: number;
  };
  getuid?: () => number | undefined;
}

export const WORKBUDDY_DISABLE_PRODUCT_CACHE_ENV = "CODEXHOST_WORKBUDDY_DISABLE_PRODUCT_CACHE";
const WORKBUDDY_PRODUCT_CONFIG_PATH_ENV = "ACC_PRODUCT_CONFIG_PATH";
const WORKBUDDY_PRODUCT_CONFIG_INLINE_ENVS = [
  "ACC_PRODUCT_CONFIG_V3",
  "ACC_PRODUCT_CONFIG_V2",
  "ACC_PRODUCT_CONFIG",
] as const;

function bundledProductConfigPath(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  dependencies: WorkBuddyInvocationDependencies,
): string | undefined {
  if (
    environment[WORKBUDDY_PRODUCT_CONFIG_PATH_ENV] !== undefined ||
    WORKBUDDY_PRODUCT_CONFIG_INLINE_ENVS.some((name) => environment[name] !== undefined)
  )
    return;

  const root = environment.WORKBUDDY_CONFIG_DIR;
  if (!root) return;
  const paths = targetPath(platform);
  const candidate = paths.join(root, "cache", "acc-product-config-v3.json");
  try {
    const inspect = dependencies.lstat ?? lstatSync;
    const uid = (dependencies.getuid ?? (() => process.getuid?.()))();
    for (const directory of [root, paths.dirname(candidate)]) {
      const metadata = inspect(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) return;
      if (platform !== "win32") {
        if ((metadata.mode & 0o022) !== 0) return;
        if (uid !== undefined && metadata.uid !== uid) return;
      }
    }
    const metadata = inspect(candidate);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0) return;
    if (platform !== "win32") {
      if ((metadata.mode & 0o077) !== 0) return;
      if (uid !== undefined && metadata.uid !== uid) return;
    }
    return candidate;
  } catch {
    return;
  }
}

export function workBuddyEnvironment(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const paths = targetPath(platform);
  const configuredRoot = environment.WORKBUDDY_CONFIG_DIR;
  const root = paths.resolve(
    configuredRoot?.trim()
      ? configuredRoot
      : paths.join(environment.HOME || environment.USERPROFILE || homedir(), ".workbuddy-ai"),
  );
  return {
    ...environment,
    // The bundled core reads CODEBUDDY_CONFIG_DIR. Force both names to one
    // WorkBuddy-owned root so a global CodeBuddy setting cannot leak history.
    CODEBUDDY_CONFIG_DIR: root,
    WORKBUDDY_CONFIG_DIR: root,
    DISABLE_AUTOUPDATER: environment.DISABLE_AUTOUPDATER ?? "1",
  };
}

export function workBuddyInvocation(
  environment: NodeJS.ProcessEnv,
  ephemeral: boolean,
  dependenciesOrArguments: WorkBuddyInvocationDependencies | string[] = {},
  argumentsOverride?: string[],
): ReturnType<CodeBuddyInvocationFactory> {
  const dependencies = Array.isArray(dependenciesOrArguments) ? {} : dependenciesOrArguments;
  const nativeArguments = Array.isArray(dependenciesOrArguments)
    ? dependenciesOrArguments
    : argumentsOverride;
  const platform = dependencies.platform ?? process.platform;
  const configured =
    environmentValue(environment, "CODEXHOST_WORKBUDDY_COMMAND")?.trim() || undefined;
  if (!configured && platform !== "darwin" && platform !== "win32")
    throw new CodeBuddyError(
      "notInstalled",
      "WorkBuddy app discovery is available on macOS and Windows; set CODEXHOST_WORKBUDDY_COMMAND for a compatible native runtime on this platform",
    );
  const isExecutable =
    dependencies.isExecutable ?? ((candidate: string) => isExecutableFile(candidate, platform));
  const configuredDirectory =
    configured && (dependencies.isDirectory ?? isDirectory)(configured) ? configured : undefined;
  const explicitExecutable =
    configured && !configuredDirectory
      ? resolveHarnessExecutable(
          workBuddyDiscoverySpec,
          { environment, platform, command: configured },
          { isExecutable },
        )?.executable
      : undefined;
  const explicitDesktop =
    explicitExecutable &&
    ((platform === "win32" &&
      /^(?:WorkBuddy|WorkBuddy AI|WorkBuddyAI)\.exe$/iu.test(
        targetPath(platform).basename(explicitExecutable),
      )) ||
      (platform === "darwin" &&
        /\/(?:WorkBuddy|WorkBuddy AI)\.app\/Contents\/MacOS\/Electron$/u.test(explicitExecutable)));
  const bundle = configuredDirectory
    ? resolveWorkBuddyInstallDirectory(configuredDirectory, environment, platform, isExecutable)
    : !configured || explicitDesktop
      ? resolveWorkBuddyBundle(environment, platform, isExecutable, explicitExecutable)
      : undefined;
  const executable =
    configured && !explicitDesktop && !configuredDirectory
      ? explicitExecutable
      : bundle?.executable;
  if (!executable)
    throw new CodeBuddyError("notInstalled", "WorkBuddy AI app or its bundled CLI is unavailable");

  const configuredEnvironment = withNodeRuntimeOnPath(
    workBuddyEnvironment(environment, platform),
    process.execPath,
    platform,
  );
  const productConfigPath =
    bundle && configuredEnvironment[WORKBUDDY_DISABLE_PRODUCT_CACHE_ENV] !== "1"
      ? bundledProductConfigPath(configuredEnvironment, platform, dependencies)
      : undefined;
  const launchEnvironment = { ...configuredEnvironment };
  delete launchEnvironment[WORKBUDDY_DISABLE_PRODUCT_CACHE_ENV];
  const childEnvironment = bundle
    ? {
        ...launchEnvironment,
        // EOF-only native Fork copies do no model work. The bundled CLI otherwise
        // waits for its telemetry channel before copying; normal ACP keeps its policy.
        ...(nativeArguments?.includes("--print") &&
        nativeArguments.includes("--fork-session") &&
        launchEnvironment.DISABLE_TELEMETRY === undefined
          ? { DISABLE_TELEMETRY: "1" }
          : {}),
        ...(productConfigPath ? { [WORKBUDDY_PRODUCT_CONFIG_PATH_ENV]: productConfigPath } : {}),
        ELECTRON_RUN_AS_NODE: "1",
      }
    : launchEnvironment;
  return {
    ...commandInvocation(
      executable,
      [
        ...(bundle ? [bundle.cli] : []),
        ...(nativeArguments ?? [
          "--acp",
          ...(ephemeral ? ["--no-session-persistence"] : []),
          ...workBuddyDelegationArguments(childEnvironment, ephemeral),
        ]),
      ],
      childEnvironment,
      platform,
    ),
    environment: childEnvironment,
  };
}
