import path from "node:path";

import {
  resolveHarnessExecutable,
  targetPath,
  VERSION_MANAGER_ROOTS,
  type HarnessDiscoverySpec,
} from "@codexhost/harness-discovery";

export class QwenCodeExecutableError extends Error {
  readonly code = "QWEN_CODE_NOT_FOUND";
}

export const qwenDiscoverySpec: HarnessDiscoverySpec = {
  id: "qwen-code",
  command: "qwen",
  commandEnvironmentVariable: "CODEXHOST_QWEN_COMMAND",
  installRoots: {
    posix: [
      "~/.qwen/bin",
      "~/.local/bin",
      VERSION_MANAGER_ROOTS,
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ],
    windows: ["~/.qwen/bin", "${APPDATA}/npm", "~/.local/bin", VERSION_MANAGER_ROOTS],
  },
};

export function resolveQwenExecutable(
  input: {
    command?: string;
    environment?: NodeJS.ProcessEnv;
    homeDirectory?: string;
    platform?: NodeJS.Platform;
  } = {},
): string {
  const platform = input.platform ?? process.platform;
  const resolution = resolveHarnessExecutable(qwenDiscoverySpec, {
    ...(input.command ? { command: input.command } : {}),
    environment: input.environment ?? process.env,
    ...(input.homeDirectory ? { homeDirectory: input.homeDirectory } : {}),
    platform,
  });
  if (!resolution) throw new QwenCodeExecutableError("Qwen Code CLI is not installed");
  return targetPath(platform).isAbsolute(resolution.executable)
    ? resolution.executable
    : path.resolve(resolution.executable);
}
