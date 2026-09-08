import path from "node:path";

import {
  resolveHarnessExecutable,
  targetPath,
  VERSION_MANAGER_ROOTS,
  type HarnessDiscoverySpec,
} from "@codexhost/harness-discovery";

export const MUSE_COMMAND_ENV = "CODEXHOST_MUSE_COMMAND";

export const museDiscoverySpec: HarnessDiscoverySpec = {
  id: "muse",
  command: "muse",
  commandEnvironmentVariable: MUSE_COMMAND_ENV,
  installRoots: {
    posix: ["~/.local/bin", VERSION_MANAGER_ROOTS, "/opt/homebrew/bin", "/usr/local/bin"],
    windows: ["${LOCALAPPDATA}/muse/bin", "~/.local/bin", VERSION_MANAGER_ROOTS],
  },
};

export function resolveMuseExecutable(
  input: {
    command?: string;
    environment?: NodeJS.ProcessEnv;
    homeDirectory?: string;
    platform?: NodeJS.Platform;
  } = {},
): string | undefined {
  const platform = input.platform ?? process.platform;
  const resolution = resolveHarnessExecutable(museDiscoverySpec, {
    ...(input.command ? { command: input.command } : {}),
    environment: input.environment ?? process.env,
    ...(input.homeDirectory ? { homeDirectory: input.homeDirectory } : {}),
    platform,
  });
  if (!resolution) return undefined;
  return targetPath(platform).isAbsolute(resolution.executable)
    ? resolution.executable
    : path.resolve(resolution.executable);
}
