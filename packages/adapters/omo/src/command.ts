import {
  resolveHarnessExecutable,
  VERSION_MANAGER_ROOTS,
  type HarnessDiscoverySpec,
} from "@codexhost/harness-discovery";

export { withNodeRuntimeOnPath } from "@codexhost/harness-discovery";

/** Explicit installation override; also declared on the discovery spec. */
export const OMO_COMMAND_ENV = "CODEXHOST_OMO_COMMAND";

export const omoDiscoverySpec: HarnessDiscoverySpec = {
  id: "omo",
  command: "omo",
  commandEnvironmentVariable: OMO_COMMAND_ENV,
  installRoots: {
    posix: [
      "~/.local/bin",
      "~/.bun/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      VERSION_MANAGER_ROOTS,
    ],
    windows: ["~/.local/bin", "~/.bun/bin", "${APPDATA}/npm", VERSION_MANAGER_ROOTS],
  },
};

export interface OmoExecutableInput {
  command?: string;
  environment: NodeJS.ProcessEnv;
}

export interface OmoExecutableDependencies {
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  isExecutable?(filePath: string): boolean;
  subdirectories?(directory: string): string[];
}

/**
 * Resolve the executable of the selected installation. An explicitly configured
 * command is authoritative: when it is not executable, this returns undefined
 * instead of silently using a different local install.
 */
export function resolveOmoExecutable(
  input: OmoExecutableInput,
  dependencies: OmoExecutableDependencies = {},
): string | undefined {
  return resolveHarnessExecutable(
    omoDiscoverySpec,
    {
      ...(input.command ? { command: input.command } : {}),
      environment: input.environment,
      ...(dependencies.platform ? { platform: dependencies.platform } : {}),
      ...(dependencies.homeDirectory ? { homeDirectory: dependencies.homeDirectory } : {}),
    },
    {
      ...(dependencies.isExecutable ? { isExecutable: dependencies.isExecutable } : {}),
      ...(dependencies.subdirectories ? { subdirectories: dependencies.subdirectories } : {}),
    },
  )?.executable;
}
