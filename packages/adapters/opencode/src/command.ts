import path from "node:path";

import {
  commandInvocation,
  resolveHarnessExecutable,
  targetPath,
  VERSION_MANAGER_ROOTS,
  type HarnessDiscoveryDependencies,
  type HarnessDiscoverySpec,
} from "@codexhost/harness-discovery";

export class OpenCodeExecutableError extends Error {
  readonly code = "OPENCODE_NOT_FOUND";

  constructor(message = "OpenCode CLI is not installed") {
    super(message);
    this.name = "OpenCodeExecutableError";
  }
}

export const openCodeDiscoverySpec: HarnessDiscoverySpec = {
  id: "opencode",
  command: "opencode",
  commandEnvironmentVariable: "CODEXHOST_OPENCODE_COMMAND",
  installRoots: {
    posix: [
      "~/.opencode/bin",
      "~/.npm-global/bin",
      "~/.local/bin",
      VERSION_MANAGER_ROOTS,
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ],
    windows: ["~/.opencode/bin", "${APPDATA}/npm", "~/.local/bin", VERSION_MANAGER_ROOTS],
  },
};

export function resolveOpenCodeExecutable(
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
    openCodeDiscoverySpec,
    {
      ...(input.command ? { command: input.command } : {}),
      environment: input.environment ?? process.env,
      ...(input.homeDirectory ? { homeDirectory: input.homeDirectory } : {}),
      platform,
    },
    dependencies,
  );
  if (!resolution) throw new OpenCodeExecutableError();
  return targetPath(platform).isAbsolute(resolution.executable)
    ? resolution.executable
    : path.resolve(resolution.executable);
}

export function openCodeServerInvocation(
  executable: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
) {
  return commandInvocation(
    executable,
    ["serve", "--hostname=127.0.0.1", "--port=0"],
    environment,
    platform,
  );
}
