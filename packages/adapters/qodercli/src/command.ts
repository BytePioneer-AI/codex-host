import path from "node:path";

import {
  commandInvocation,
  resolveHarnessExecutable,
  targetPath,
  VERSION_MANAGER_ROOTS,
  type HarnessDiscoveryDependencies,
  type HarnessDiscoverySpec,
} from "@codexhost/harness-discovery";

export class QoderExecutableError extends Error {
  readonly code = "QODERCLI_NOT_FOUND";
}

export const qoderDiscoverySpec: HarnessDiscoverySpec = {
  id: "qodercli",
  command: "qodercli",
  commandEnvironmentVariable: "CODEXHOST_QODER_COMMAND",
  installRoots: {
    posix: [
      "~/.local/bin",
      "~/.qoder/bin",
      "~/.qoder/bin/qodercli",
      "~/.npm-global/bin",
      VERSION_MANAGER_ROOTS,
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ],
    windows: ["${APPDATA}/npm", "${LOCALAPPDATA}/qodercli", "~/.local/bin", VERSION_MANAGER_ROOTS],
  },
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
  const resolution = resolveHarnessExecutable(
    qoderDiscoverySpec,
    {
      ...(input.command ? { command: input.command } : {}),
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

export function qoderInvocation(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  platform = process.platform,
) {
  return commandInvocation(command, args, environment, platform);
}
