import path from "node:path";

import {
  resolveHarnessExecutable,
  targetPath,
  VERSION_MANAGER_ROOTS,
  type HarnessDiscoverySpec,
} from "@codexhost/harness-discovery";

export const hmHarnessDiscoverySpec: HarnessDiscoverySpec = {
  id: "hmharness",
  command: "hmh-codexhost",
  commandEnvironmentVariable: "CODEXHOST_HMHARNESS_COMMAND",
  installRoots: {
    posix: [
      "~/.npm-global/bin",
      "~/.local/bin",
      VERSION_MANAGER_ROOTS,
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ],
    windows: ["${APPDATA}/npm", "~/.local/bin", VERSION_MANAGER_ROOTS],
  },
};

export function resolveHmHarnessExecutable(
  input: {
    command?: string;
    environment?: NodeJS.ProcessEnv;
    homeDirectory?: string;
    platform?: NodeJS.Platform;
  } = {},
): string | undefined {
  const platform = input.platform ?? process.platform;
  const resolution = resolveHarnessExecutable(hmHarnessDiscoverySpec, {
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
