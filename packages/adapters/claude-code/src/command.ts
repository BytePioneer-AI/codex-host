import path from "node:path";

import {
  resolveHarnessExecutable,
  targetPath,
  VERSION_MANAGER_ROOTS,
  type HarnessDiscoveryDependencies,
  type HarnessDiscoverySpec,
} from "@codexhost/harness-discovery";

export { withNodeRuntimeOnPath } from "@codexhost/harness-discovery";

export class ClaudeCodeExecutableError extends Error {
  readonly code = "CLAUDE_NOT_FOUND";
}

const CLAUDE_NPM_PACKAGE_BIN = "node_modules/@anthropic-ai/claude-code/bin";

export const claudeCodeDiscoverySpec: HarnessDiscoverySpec = {
  id: "claude-code",
  command: "claude",
  commandEnvironmentVariable: "CODEXHOST_CLAUDE_COMMAND",
  installRoots: {
    posix: [
      "~/.npm-global/bin",
      "~/.local/bin",
      "~/.claude/local",
      VERSION_MANAGER_ROOTS,
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ],
    windows: [
      `\${APPDATA}/npm/${CLAUDE_NPM_PACKAGE_BIN}`,
      "${APPDATA}/npm",
      "~/.local/bin",
      VERSION_MANAGER_ROOTS,
    ],
  },
  // Prefer Claude Code's native binary over the npm CMD shim beside it: the
  // shim spawns an extra cmd.exe and loses signal handling.
  runnableCandidate: (candidate, { platform, isExecutable }) => {
    const pathFlavor = targetPath(platform);
    if (platform !== "win32" || pathFlavor.basename(candidate).toLowerCase() !== "claude.cmd") {
      return candidate;
    }
    const native = pathFlavor.join(
      pathFlavor.dirname(candidate),
      ...CLAUDE_NPM_PACKAGE_BIN.split("/"),
      "claude.exe",
    );
    return isExecutable(native) ? native : undefined;
  },
};

export function resolveClaudeCodeExecutable(
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
    claudeCodeDiscoverySpec,
    {
      ...(input.command ? { command: input.command } : {}),
      environment: input.environment ?? process.env,
      ...(input.homeDirectory ? { homeDirectory: input.homeDirectory } : {}),
      platform,
    },
    dependencies,
  );
  if (!resolution) throw new ClaudeCodeExecutableError("Claude Code is not installed");
  return targetPath(platform).isAbsolute(resolution.executable)
    ? resolution.executable
    : path.resolve(resolution.executable);
}
