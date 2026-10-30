import path from "node:path";

import {
  commandInvocation,
  resolveHarnessExecutable,
  targetPath,
  type HarnessDiscoverySpec,
} from "@codexhost/harness-discovery";

export class KimiExecutableError extends Error {
  readonly code = "KIMI_NOT_FOUND";
}

export const KIMI_COMMAND_ENV = "CODEXHOST_KIMI_COMMAND";

export const kimiDiscoverySpec: HarnessDiscoverySpec = {
  id: "kimi-code",
  command: "kimi",
  commandEnvironmentVariable: KIMI_COMMAND_ENV,
  installRoots: {
    windows: ["~/.kimi-code/bin", "${APPDATA}/npm"],
    posix: ["~/.kimi-code/bin", "~/.local/bin", "/usr/local/bin"],
  },
};

export function resolveKimiExecutable(
  input: {
    command?: string;
    environment?: NodeJS.ProcessEnv;
    homeDirectory?: string;
    platform?: NodeJS.Platform;
  } = {},
): string {
  const platform = input.platform ?? process.platform;
  const resolution = resolveHarnessExecutable(kimiDiscoverySpec, {
    ...(input.command ? { command: input.command } : {}),
    environment: input.environment ?? process.env,
    ...(input.homeDirectory ? { homeDirectory: input.homeDirectory } : {}),
    platform,
  });
  if (!resolution) throw new KimiExecutableError("Kimi Code CLI is not installed");
  return targetPath(platform).isAbsolute(resolution.executable)
    ? resolution.executable
    : path.resolve(resolution.executable);
}

export function kimiInvocation(
  command: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): {
  command: string;
  arguments: string[];
  windowsVerbatimArguments: boolean;
} {
  return commandInvocation(command, ["acp"], environment, platform);
}
