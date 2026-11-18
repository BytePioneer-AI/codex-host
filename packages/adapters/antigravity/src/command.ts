import { closeSync, openSync, readSync } from "node:fs";
import path from "node:path";

import {
  resolveHarnessExecutable,
  targetPath,
  type HarnessDiscoverySpec,
} from "@codexhost/harness-discovery";

/** Electron's desktop bootstrap is not the native ACP CLI. */
function isDesktopLauncher(candidate: string): boolean {
  try {
    const descriptor = openSync(candidate, "r");
    try {
      const prefix = Buffer.alloc(4096);
      const length = readSync(descriptor, prefix, 0, prefix.length, 0);
      const source = prefix.toString("utf8", 0, length);
      return /\bELECTRON_RUN_AS_NODE\b/u.test(source) && /\bout[/\\]cli\.js\b/iu.test(source);
    } finally {
      closeSync(descriptor);
    }
  } catch {
    return false;
  }
}

export const antigravityDiscoverySpec: HarnessDiscoverySpec = {
  id: "antigravity",
  command: "agy",
  commandEnvironmentVariable: "CODEXHOST_ANTIGRAVITY_COMMAND",
  installRoots: {
    posix: ["~/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"],
    windows: ["${LOCALAPPDATA}/agy/bin", "~/.local/bin"],
  },
  runnableCandidate: (candidate, { isExecutable }) =>
    isExecutable(candidate) && !isDesktopLauncher(candidate) ? candidate : undefined,
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
