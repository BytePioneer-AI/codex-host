import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export class GrokExecutableError extends Error {
  readonly code = "GROK_NOT_FOUND";
}

function pathValue(environment: NodeJS.ProcessEnv): string {
  const key = Object.keys(environment).find((name) => name.toLowerCase() === "path");
  return key ? (environment[key] ?? "") : "";
}

function commandCandidates(
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

export function resolveGrokExecutable(
  input: {
    command?: string;
    environment?: NodeJS.ProcessEnv;
    homeDirectory?: string;
    platform?: NodeJS.Platform;
  } = {},
): string {
  const environment = input.environment ?? process.env;
  const platform = input.platform ?? process.platform;
  const configured = input.command ?? environment.CODEXHOST_GROK_COMMAND;
  const home = input.homeDirectory ?? environment.HOME ?? environment.USERPROFILE ?? os.homedir();
  const command = configured ?? "grok";
  const userCandidates =
    platform === "win32"
      ? [
          path.join(home, ".grok", "bin", "grok.exe"),
          path.join(home, ".grok", "bin", "grok.cmd"),
          path.join(
            environment.APPDATA ?? path.join(home, "AppData", "Roaming"),
            "npm",
            "grok.cmd",
          ),
        ]
      : [
          path.join(home, ".grok", "bin", "grok"),
          path.join(home, ".local", "bin", "grok"),
          "/opt/homebrew/bin/grok",
          "/usr/local/bin/grok",
        ];
  const found = [
    ...commandCandidates(command, platform, environment),
    ...(configured ? [] : userCandidates),
  ].find((candidate) => isExecutable(candidate, platform));
  if (!found) throw new GrokExecutableError("Grok CLI is not installed");
  return path.resolve(found);
}

export function grokInvocation(
  command: string,
  platform = process.platform,
): {
  command: string;
  arguments: string[];
  windowsVerbatimArguments: boolean;
} {
  const arguments_ = ["agent", "--no-leader", "stdio"];
  const extension = path.win32.extname(command).toLowerCase();
  if (platform !== "win32" || ![".cmd", ".bat"].includes(extension)) {
    return { command, arguments: arguments_, windowsVerbatimArguments: false };
  }
  const quote = (value: string): string => `"${value.replaceAll("%", "%%").replaceAll('"', '""')}"`;
  const commandLine = [command, ...arguments_].map(quote).join(" ");
  return {
    command: process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe",
    arguments: ["/d", "/v:off", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}
