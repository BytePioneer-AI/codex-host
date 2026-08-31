import path from "node:path";

import {
  commandInvocation,
  resolveHarnessExecutable,
  targetPath,
  VERSION_MANAGER_ROOTS,
  type HarnessDiscoverySpec,
} from "@codexhost/harness-discovery";

export class GeminiExecutableError extends Error {
  readonly code = "GEMINI_NOT_FOUND";
}

export const geminiDiscoverySpec: HarnessDiscoverySpec = {
  id: "gemini",
  command: "gemini",
  commandEnvironmentVariable: "CODEXHOST_GEMINI_COMMAND",
  installRoots: {
    posix: [
      "~/.gemini/bin",
      "~/.local/bin",
      VERSION_MANAGER_ROOTS,
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ],
    windows: ["~/.gemini/bin", "${APPDATA}/npm", "~/.local/bin", VERSION_MANAGER_ROOTS],
  },
};

export function resolveGeminiExecutable(
  input: {
    command?: string;
    environment?: NodeJS.ProcessEnv;
    homeDirectory?: string;
    platform?: NodeJS.Platform;
  } = {},
): string {
  const platform = input.platform ?? process.platform;
  const resolution = resolveHarnessExecutable(geminiDiscoverySpec, {
    ...(input.command ? { command: input.command } : {}),
    environment: input.environment ?? process.env,
    ...(input.homeDirectory ? { homeDirectory: input.homeDirectory } : {}),
    platform,
  });
  if (!resolution) throw new GeminiExecutableError("Gemini CLI is not installed");
  return targetPath(platform).isAbsolute(resolution.executable)
    ? resolution.executable
    : path.resolve(resolution.executable);
}

export function geminiInvocation(
  command: string,
  platform = process.platform,
): {
  command: string;
  arguments: string[];
  windowsVerbatimArguments: boolean;
} {
  // Gemini CLI exposes ACP directly (unlike the Grok agent wrapper).
  return commandInvocation(command, ["--acp"], process.env, platform);
}
