import { accessSync, constants, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface OmpExecutableDependencies {
  platform: NodeJS.Platform;
  homeDirectory: string;
  isExecutable(filePath: string): boolean;
}

function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.entries(environment).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

function isExecutable(filePath: string, platform: NodeJS.Platform): boolean {
  try {
    accessSync(filePath, platform === "win32" ? constants.F_OK : constants.X_OK);
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function pathCandidates(
  command: string,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): string[] {
  const targetPath = platform === "win32" ? path.win32 : path.posix;
  if (targetPath.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return [command];
  }
  const extensions =
    platform === "win32" && targetPath.extname(command) === ""
      ? (environmentValue(environment, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .map((extension) => extension.trim())
          .filter(Boolean)
      : [""];
  return (environmentValue(environment, "PATH") ?? "")
    .split(targetPath.delimiter)
    .map((directory) => directory.trim().replace(/^"|"$/gu, ""))
    .filter(Boolean)
    .flatMap((directory) =>
      extensions.map((extension) => targetPath.join(directory, command + extension)),
    );
}

function nvmCandidates(
  homeDirectory: string,
  executableName: string,
  targetPath: typeof path,
): string[] {
  const versionsDirectory = targetPath.join(homeDirectory, ".nvm", "versions", "node");
  try {
    return readdirSync(versionsDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
      .map((version) => targetPath.join(versionsDirectory, version, "bin", executableName));
  } catch {
    return [];
  }
}

function userInstallCandidates(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  homeDirectory: string,
): string[] {
  const targetPath = platform === "win32" ? path.win32 : path.posix;
  if (platform === "win32") {
    const appData = environment.APPDATA ?? targetPath.join(homeDirectory, "AppData", "Roaming");
    return [
      targetPath.join(appData, "npm", "omp.cmd"),
      targetPath.join(homeDirectory, ".local", "bin", "omp.exe"),
      targetPath.join(homeDirectory, ".local", "bin", "omp.cmd"),
    ];
  }
  return [
    targetPath.join(homeDirectory, ".npm-global", "bin", "omp"),
    targetPath.join(homeDirectory, ".local", "bin", "omp"),
    ...nvmCandidates(homeDirectory, "omp", targetPath),
    "/opt/homebrew/bin/omp",
    "/usr/local/bin/omp",
  ];
}

export function resolveOmpExecutable(
  input: {
    command?: string;
    environment: NodeJS.ProcessEnv;
  },
  dependencies: Partial<OmpExecutableDependencies> = {},
): string {
  const platform = dependencies.platform ?? process.platform;
  const configuredCommand = input.command ?? input.environment.OMP_COMMAND;
  const command = configuredCommand ?? "omp";
  const homeDirectory =
    dependencies.homeDirectory ??
    input.environment.HOME ??
    input.environment.USERPROFILE ??
    os.homedir();
  const candidates = [
    ...pathCandidates(command, platform, input.environment),
    ...(configuredCommand ? [] : userInstallCandidates(platform, input.environment, homeDirectory)),
  ];
  const check =
    dependencies.isExecutable ?? ((candidate: string) => isExecutable(candidate, platform));
  return candidates.find(check) ?? command;
}

export function withNodeRuntimeOnPath(
  environment: NodeJS.ProcessEnv,
  runtimeExecutable = process.execPath,
  platform = process.platform,
): NodeJS.ProcessEnv {
  const pathKey = Object.keys(environment).find((name) => name.toLowerCase() === "path") ?? "PATH";
  const delimiter = platform === "win32" ? ";" : ":";
  const runtimeDirectory = path.dirname(runtimeExecutable);
  const directories = (environment[pathKey] ?? "").split(delimiter).filter(Boolean);
  const equal =
    platform === "win32" ? (value: string) => value.toLowerCase() : (value: string) => value;
  if (!directories.some((directory) => equal(directory) === equal(runtimeDirectory))) {
    directories.unshift(runtimeDirectory);
  }
  return { ...environment, [pathKey]: directories.join(delimiter) };
}
