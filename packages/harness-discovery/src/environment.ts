import fs from "node:fs";
import path from "node:path";

/** Path semantics for a target platform. Production always matches the host. */
export function targetPath(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

/** Windows environment blocks are case-insensitive; POSIX ones are not. */
export function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const lowered = name.toLowerCase();
  for (const [key, value] of Object.entries(environment)) {
    if (key.toLowerCase() === lowered) return value;
  }
  return undefined;
}

export function pathDelimiter(platform: NodeJS.Platform): string {
  return platform === "win32" ? ";" : ":";
}

export function pathDirectories(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] {
  return (environmentValue(environment, "PATH") ?? "")
    .split(pathDelimiter(platform))
    .map((directory) => directory.trim().replace(/^"|"$/gu, ""))
    .filter(Boolean);
}

/** Extensions probed for a bare command name. Only Windows has any. */
export function executableExtensions(
  command: string,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): string[] {
  if (platform !== "win32") return [""];
  if (targetPath(platform).extname(command) !== "") return [""];
  return (environmentValue(environment, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean);
}

export function isExecutableFile(filePath: string, platform: NodeJS.Platform): boolean {
  try {
    fs.accessSync(filePath, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function subdirectoryNames(directory: string): string[] {
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** Newest first, so a harness installed under several runtimes resolves predictably. */
export function newestFirst(names: readonly string[]): string[] {
  return [...names].sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
}
