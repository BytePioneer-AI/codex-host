import {
  resolveHarnessExecutable,
  VERSION_MANAGER_ROOTS,
  type HarnessDiscoverySpec,
} from "@codexhost/harness-discovery";

export interface CodeBuddyExecutableDependencies {
  platform: NodeJS.Platform;
  homeDirectory: string;
  isExecutable(filePath: string): boolean;
}

export const codebuddyDiscoverySpec: HarnessDiscoverySpec = {
  id: "codebuddy",
  command: "codebuddy",
  commandEnvironmentVariable: "CODEXHOST_CODEBUDDY_COMMAND",
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

export function resolveCodeBuddyExecutable(
  input: {
    command?: string;
    environment: NodeJS.ProcessEnv;
  },
  dependencies: Partial<CodeBuddyExecutableDependencies> = {},
): string {
  const resolution = resolveHarnessExecutable(
    codebuddyDiscoverySpec,
    {
      ...(input.command ? { command: input.command } : {}),
      environment: input.environment,
      ...(dependencies.platform ? { platform: dependencies.platform } : {}),
      ...(dependencies.homeDirectory ? { homeDirectory: dependencies.homeDirectory } : {}),
    },
    { ...(dependencies.isExecutable ? { isExecutable: dependencies.isExecutable } : {}) },
  );
  return (
    resolution?.executable ??
    input.command ??
    input.environment.CODEXHOST_CODEBUDDY_COMMAND ??
    "codebuddy"
  );
}
