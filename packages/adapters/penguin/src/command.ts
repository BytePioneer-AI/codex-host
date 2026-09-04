import {
  resolveHarnessExecutable,
  VERSION_MANAGER_ROOTS,
  type HarnessDiscoverySpec,
} from "@codexhost/harness-discovery";

export { commandInvocation, withNodeRuntimeOnPath } from "@codexhost/harness-discovery";

export const PENGUIN_COMMAND_ENV = "CODEXHOST_PENGUIN_COMMAND";

export interface PenguinExecutableDependencies {
  platform: NodeJS.Platform;
  homeDirectory: string;
  isExecutable(filePath: string): boolean;
}

export const penguinDiscoverySpec: HarnessDiscoverySpec = {
  id: "penguin",
  command: "penguin",
  commandEnvironmentVariable: PENGUIN_COMMAND_ENV,
  installRoots: {
    posix: [
      "~/.npm-global/bin",
      "~/.local/bin",
      "~/.penguin/bin",
      VERSION_MANAGER_ROOTS,
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ],
    windows: ["${APPDATA}/npm", "~/.local/bin", "~/.penguin/bin", VERSION_MANAGER_ROOTS],
  },
};

export function resolvePenguinExecutable(
  input: {
    command?: string;
    environment: NodeJS.ProcessEnv;
  },
  dependencies: Partial<PenguinExecutableDependencies> = {},
): string {
  const resolution = resolveHarnessExecutable(
    penguinDiscoverySpec,
    {
      ...(input.command ? { command: input.command } : {}),
      environment: input.environment,
      ...(dependencies.platform ? { platform: dependencies.platform } : {}),
      ...(dependencies.homeDirectory ? { homeDirectory: dependencies.homeDirectory } : {}),
    },
    { ...(dependencies.isExecutable ? { isExecutable: dependencies.isExecutable } : {}) },
  );
  return (
    resolution?.executable ?? input.command ?? input.environment[PENGUIN_COMMAND_ENV] ?? "penguin"
  );
}
