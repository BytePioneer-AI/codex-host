import {
  resolveHarnessExecutable,
  VERSION_MANAGER_ROOTS,
  type HarnessDiscoverySpec,
} from "@codexhost/harness-discovery";

export { withNodeRuntimeOnPath } from "@codexhost/harness-discovery";

export interface OmpExecutableDependencies {
  platform: NodeJS.Platform;
  homeDirectory: string;
  isExecutable(filePath: string): boolean;
}

export const ompDiscoverySpec: HarnessDiscoverySpec = {
  id: "omp",
  command: "omp",
  commandEnvironmentVariable: "OMP_COMMAND",
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

export function resolveOmpExecutable(
  input: {
    command?: string;
    environment: NodeJS.ProcessEnv;
  },
  dependencies: Partial<OmpExecutableDependencies> = {},
): string {
  const resolution = resolveHarnessExecutable(
    ompDiscoverySpec,
    {
      ...(input.command ? { command: input.command } : {}),
      environment: input.environment,
      ...(dependencies.platform ? { platform: dependencies.platform } : {}),
      ...(dependencies.homeDirectory ? { homeDirectory: dependencies.homeDirectory } : {}),
    },
    { ...(dependencies.isExecutable ? { isExecutable: dependencies.isExecutable } : {}) },
  );
  return resolution?.executable ?? input.command ?? input.environment.OMP_COMMAND ?? "omp";
}
