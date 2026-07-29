import fs from "node:fs";
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

export function resolveClaudeCodeExecutable(
  input: {
    command?: string;
    environment?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
  } = {},
): string {
  const environment = input.environment ?? process.env;
  const platform = input.platform ?? process.platform;
  const command = input.command ?? environment.CODEXHOST_CLAUDE_COMMAND ?? "claude";
  const executable = candidates(command, platform, environment).find((candidate) =>
    isExecutable(candidate, platform),
  );
  if (!executable) throw new ClaudeCodeExecutableError("Claude Code is not installed");
  return path.resolve(executable);
}
