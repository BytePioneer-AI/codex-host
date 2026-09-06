import path from "node:path";

import {
  resolveHarnessExecutable,
  targetPath,
  type HarnessDiscoverySpec,
} from "@codexhost/harness-discovery";

export const antigravityDiscoverySpec: HarnessDiscoverySpec = {
  id: "antigravity",
  command: "agy",
  commandEnvironmentVariable: "CODEXHOST_ANTIGRAVITY_COMMAND",
  installRoots: {
    posix: ["~/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"],
    windows: ["${LOCALAPPDATA}/agy/bin", "~/.local/bin"],
  },
};

export function resolveAntigravityExecutable(
  input: {
    command?: string;
    environment?: NodeJS.ProcessEnv;
    homeDirectory?: string;
    platform?: NodeJS.Platform;
  } = {},
): string | undefined {
  const platform = input.platform ?? process.platform;
  const resolution = resolveHarnessExecutable(antigravityDiscoverySpec, {
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
