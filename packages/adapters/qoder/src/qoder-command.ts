import path from "node:path";
import {
  resolveHarnessExecutable,
  targetPath,
  VERSION_MANAGER_ROOTS,
  type HarnessDiscoveryDependencies,
  type HarnessDiscoverySpec,
} from "@codexhost/harness-discovery";

export class QoderExecutableError extends Error {
  readonly code = "QODER_NOT_FOUND";
}

export const CODEXHOST_QODER_COMMAND = "CODEXHOST_QODER_COMMAND";
export const QODER_SDK_CUSTOM_BASE_URL_BYOK = "QODER_SDK_CUSTOM_BASE_URL_BYOK";
const QODER_NPM_CLI_ENTRYPOINT = "node_modules/@qoder-ai/qodercli/bundle/qodercli.js";

export function qoderEnvironment(
  environment?: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return {
    ...environment,
    [QODER_SDK_CUSTOM_BASE_URL_BYOK]: environment?.[QODER_SDK_CUSTOM_BASE_URL_BYOK] ?? "1",
  };
}

export const qoderDiscoverySpec: HarnessDiscoverySpec = {
  id: "qoder",
  command: "qodercli",
  commandEnvironmentVariable: CODEXHOST_QODER_COMMAND,
  installRoots: {
    posix: [
      "~/.local/bin",
      "~/.qoder/bin",
      VERSION_MANAGER_ROOTS,
      "/usr/local/bin",
      "/opt/homebrew/bin",
    ],
    windows: [
      "${LOCALAPPDATA}/Programs/Qoder",
      "${LOCALAPPDATA}/Qoder",
      "~/.qoder/bin",
      "${APPDATA}/npm",
      VERSION_MANAGER_ROOTS,
    ],
  },
  runnableCandidate: (candidate, { platform, isExecutable }) => {
    const pathFlavor = targetPath(platform);
    if (platform !== "win32" || pathFlavor.extname(candidate).toLowerCase() !== ".cmd") {
      return candidate;
    }
    const entrypoint = pathFlavor.join(
      pathFlavor.dirname(candidate),
      ...QODER_NPM_CLI_ENTRYPOINT.split("/"),
    );
    return isExecutable(entrypoint) ? entrypoint : undefined;
  },
};

export const qoderFallbackSpec: HarnessDiscoverySpec = {
  ...qoderDiscoverySpec,
  command: "qoder",
};

export function resolveQoderExecutable(
  input: {
    command?: string;
    environment?: NodeJS.ProcessEnv;
    homeDirectory?: string;
    platform?: NodeJS.Platform;
  } = {},
  dependencies: HarnessDiscoveryDependencies = {},
): string {
  const platform = input.platform ?? process.platform;
  const resolution =
    resolveHarnessExecutable(
      qoderDiscoverySpec,
      {
        ...(input.command ? { command: input.command } : {}),
        environment: input.environment ?? process.env,
        ...(input.homeDirectory ? { homeDirectory: input.homeDirectory } : {}),
        platform,
      },
      dependencies,
    ) ??
    resolveHarnessExecutable(
      qoderFallbackSpec,
      {
        environment: input.environment ?? process.env,
        ...(input.homeDirectory ? { homeDirectory: input.homeDirectory } : {}),
        platform,
      },
      dependencies,
    );

  if (!resolution) throw new QoderExecutableError("Qoder CLI is not installed");
  return targetPath(platform).isAbsolute(resolution.executable)
    ? resolution.executable
    : path.resolve(resolution.executable);
}
