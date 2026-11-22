import path from "node:path";

import {
  resolveHarnessExecutable,
  targetPath,
  VERSION_MANAGER_ROOTS,
  type HarnessDiscoveryDependencies,
  type HarnessDiscoverySpec,
} from "@codexhost/harness-discovery";

const QWEN_NPM_ENTRY = "node_modules/@qwen-code/qwen-code/cli-entry.js";

export const qwenCodeDiscoverySpec: HarnessDiscoverySpec = {
  id: "qwen-code",
  command: "qwen",
  commandEnvironmentVariable: "CODEXHOST_QWEN_COMMAND",
  installRoots: {
    posix: ["~/.npm-global/bin", "~/.local/bin", VERSION_MANAGER_ROOTS],
    windows: ["${APPDATA}/npm", "~/.local/bin", VERSION_MANAGER_ROOTS],
  },
  // The official SDK launches a JavaScript entrypoint itself. A Windows npm
  // `.cmd` shim cannot be used as `pathToQwenExecutable`, so resolve it to
  // Qwen Code's installed JavaScript entrypoint instead.
  runnableCandidate: (candidate, { platform, isExecutable }) => {
    const pathFlavor = targetPath(platform);
    if (platform !== "win32" || pathFlavor.basename(candidate).toLowerCase() !== "qwen.cmd") {
      return candidate;
    }
    const entrypoint = pathFlavor.join(pathFlavor.dirname(candidate), ...QWEN_NPM_ENTRY.split("/"));
    return isExecutable(entrypoint) ? entrypoint : undefined;
  },
};

export function resolveQwenCodeExecutable(
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
    qwenCodeDiscoverySpec,
    {
      ...(input.command ? { command: input.command } : {}),
      environment: input.environment ?? process.env,
      ...(input.homeDirectory ? { homeDirectory: input.homeDirectory } : {}),
      platform,
    },
    dependencies,
  );
  if (!resolution) throw new Error("Executable file not found: Qwen Code CLI is not installed");
  return targetPath(platform).isAbsolute(resolution.executable)
    ? resolution.executable
    : path.resolve(resolution.executable);
}
