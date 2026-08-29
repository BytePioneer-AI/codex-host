import path from "node:path";

import {
  commandInvocation,
  resolveHarnessExecutable,
  targetPath,
  VERSION_MANAGER_ROOTS,
  type HarnessDiscoverySpec,
} from "@codexhost/harness-discovery";

export class GrokExecutableError extends Error {
  readonly code = "GROK_NOT_FOUND";
}

export const grokDiscoverySpec: HarnessDiscoverySpec = {
  id: "grok",
  command: "grok",
  commandEnvironmentVariable: "CODEXHOST_GROK_COMMAND",
  installRoots: {
    posix: [
      "~/.grok/bin",
      "~/.local/bin",
      VERSION_MANAGER_ROOTS,
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ],
    windows: ["~/.grok/bin", "${APPDATA}/npm", "~/.local/bin", VERSION_MANAGER_ROOTS],
  },
};

export function resolveGrokExecutable(
  input: {
    command?: string;
    environment?: NodeJS.ProcessEnv;
    homeDirectory?: string;
    platform?: NodeJS.Platform;
  } = {},
): string {
  const platform = input.platform ?? process.platform;
  const resolution = resolveHarnessExecutable(grokDiscoverySpec, {
    ...(input.command ? { command: input.command } : {}),
    environment: input.environment ?? process.env,
    ...(input.homeDirectory ? { homeDirectory: input.homeDirectory } : {}),
    platform,
  });
  if (!resolution) throw new GrokExecutableError("Grok CLI is not installed");
  return targetPath(platform).isAbsolute(resolution.executable)
    ? resolution.executable
    : path.resolve(resolution.executable);
}

export function grokInvocation(
  command: string,
  platform = process.platform,
): {
  command: string;
  arguments: string[];
  windowsVerbatimArguments: boolean;
} {
  return commandInvocation(command, ["agent", "--no-leader", "stdio"], process.env, platform);
}
