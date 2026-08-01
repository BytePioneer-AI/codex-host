import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export class ClaudeCodeExecutableError extends Error {
  readonly code = "CLAUDE_NOT_FOUND";
}

function pathValue(environment: NodeJS.ProcessEnv): string {
  const key = Object.keys(environment).find((name) => name.toLowerCase() === "path");
  return key ? (environment[key] ?? "") : "";
}

function candidates(
  command: string,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): string[] {
  if (path.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return [command];
  }
  const delimiter = platform === "win32" ? ";" : ":";
  const extensions =
    platform === "win32" && path.extname(command) === ""
      ? (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
      : [""];
  return pathValue(environment)
    .split(delimiter)
    .filter(Boolean)
    .flatMap((directory) =>
      extensions.map((extension) => path.join(directory, command + extension)),
    );
}

function isExecutable(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    fs.accessSync(candidate, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function nvmCandidates(homeDirectory: string): string[] {
  const versionsDirectory = path.join(homeDirectory, ".nvm", "versions", "node");
  try {
    return fs
      .readdirSync(versionsDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
      .map((version) => path.join(versionsDirectory, version, "bin", "claude"));
  } catch {
    return [];
  }
}

function userInstallCandidates(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  homeDirectory: string,
): string[] {
  if (platform === "win32") {
    const appData = environment.APPDATA ?? path.join(homeDirectory, "AppData", "Roaming");
    return [
      path.join(appData, "npm", "claude.cmd"),
      path.join(homeDirectory, ".local", "bin", "claude.exe"),
      path.join(homeDirectory, ".local", "bin", "claude.cmd"),
    ];
  }
  return [
    path.join(homeDirectory, ".local", "bin", "claude"),
    path.join(homeDirectory, ".claude", "local", "claude"),
    ...nvmCandidates(homeDirectory),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
}

export function resolveClaudeCodeExecutable(
  input: {
    command?: string;
    environment?: NodeJS.ProcessEnv;
    homeDirectory?: string;
    platform?: NodeJS.Platform;
  } = {},
): string {
  const environment = input.environment ?? process.env;
  const platform = input.platform ?? process.platform;
  const configuredCommand = input.command ?? environment.CODEXHOST_CLAUDE_COMMAND;
  const command = configuredCommand ?? "claude";
  const homeDirectory =
    input.homeDirectory ?? environment.HOME ?? environment.USERPROFILE ?? os.homedir();
  const resolutionCandidates = [
    ...candidates(command, platform, environment),
    ...(configuredCommand ? [] : userInstallCandidates(platform, environment, homeDirectory)),
  ];
  const executable = resolutionCandidates.find((candidate) => isExecutable(candidate, platform));
  if (!executable) throw new ClaudeCodeExecutableError("Claude Code is not installed");
  return path.resolve(executable);
}
