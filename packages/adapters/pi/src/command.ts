import fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import {
  resolveHarnessExecutable,
  VERSION_MANAGER_ROOTS,
  type HarnessDiscoverySpec,
} from "@codexhost/harness-discovery";

export { withNodeRuntimeOnPath } from "@codexhost/harness-discovery";

export interface PiExecutableDependencies {
  platform: NodeJS.Platform;
  homeDirectory: string;
  isExecutable(filePath: string): boolean;
}

export const piDiscoverySpec: HarnessDiscoverySpec = {
  id: "pi",
  command: "pi",
  commandEnvironmentVariable: "PI_COMMAND",
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

export function resolvePiExecutable(
  input: {
    command?: string;
    environment: NodeJS.ProcessEnv;
  },
  dependencies: Partial<PiExecutableDependencies> = {},
): string {
  const resolution = resolveHarnessExecutable(
    piDiscoverySpec,
    {
      ...(input.command ? { command: input.command } : {}),
      environment: input.environment,
      ...(dependencies.platform ? { platform: dependencies.platform } : {}),
      ...(dependencies.homeDirectory ? { homeDirectory: dependencies.homeDirectory } : {}),
    },
    { ...(dependencies.isExecutable ? { isExecutable: dependencies.isExecutable } : {}) },
  );
  return resolution?.executable ?? input.command ?? input.environment.PI_COMMAND ?? "pi";
}

function isFilesystemRoot(cwd: string): boolean {
  const resolved = path.resolve(cwd);
  return resolved === path.parse(resolved).root;
}

function writableDirectory(candidate: string | undefined): string | undefined {
  if (!candidate || !path.isAbsolute(candidate) || isFilesystemRoot(candidate)) return undefined;
  try {
    if (!fs.statSync(candidate).isDirectory()) return undefined;
    fs.accessSync(candidate, fs.constants.R_OK | fs.constants.W_OK);
    return candidate;
  } catch {
    return undefined;
  }
}

export function resolvePiInspectCwd(
  inputCwd: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (typeof inputCwd === "string" && inputCwd.length > 0 && !isFilesystemRoot(inputCwd)) {
    return path.resolve(inputCwd);
  }
  const candidates = [environment.USERPROFILE, environment.HOME, homedir(), tmpdir()];
  for (const candidate of candidates) {
    const usable = writableDirectory(candidate);
    if (usable) return usable;
  }
  return inputCwd && inputCwd.length > 0 ? path.resolve(inputCwd) : process.cwd();
}
