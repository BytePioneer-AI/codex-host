import path from "node:path";

import {
  commandInvocation,
  resolveHarnessExecutable,
  targetPath,
  VERSION_MANAGER_ROOTS,
  type HarnessDiscoveryDependencies,
  type HarnessDiscoverySpec,
} from "@codexhost/harness-discovery";

export class KiroExecutableError extends Error {
  readonly code = "KIRO_NOT_FOUND";
}

export const kiroDiscoverySpec: HarnessDiscoverySpec = {
  id: "kiro-cli",
  command: "kiro-cli",
  commandEnvironmentVariable: "CODEXHOST_KIRO_COMMAND",
  installRoots: {
    posix: [
      "~/.local/bin",
      "~/.kiro/bin",
      VERSION_MANAGER_ROOTS,
      "/usr/local/bin",
      "/opt/homebrew/bin",
    ],
    windows: ["${LOCALAPPDATA}/Kiro-Cli", "~/.kiro/bin", "${APPDATA}/npm", VERSION_MANAGER_ROOTS],
  },
};

export function resolveKiroExecutable(
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
    kiroDiscoverySpec,
    {
      ...(input.command ? { command: input.command } : {}),
      environment: input.environment ?? process.env,
      ...(input.homeDirectory ? { homeDirectory: input.homeDirectory } : {}),
      platform,
    },
    dependencies,
  );
  if (!resolution) throw new KiroExecutableError("Kiro CLI is not installed");
  return targetPath(platform).isAbsolute(resolution.executable)
    ? resolution.executable
    : path.resolve(resolution.executable);
}

export function kiroInvocation(
  command: string,
  platform = process.platform,
): {
  command: string;
  arguments: string[];
  windowsVerbatimArguments: boolean;
} {
  return commandInvocation(
    command,
    ["acp", "--agent-engine", "v3", "--auth-method", "cli"],
    process.env,
    platform,
  );
}
