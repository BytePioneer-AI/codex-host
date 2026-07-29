import fs from "node:fs";
import path from "node:path";

function pathValue(env) {
  const key = Object.keys(env).find((name) => name.toLowerCase() === "path");
  return key === undefined ? "" : (env[key] ?? "");
}

function executableCandidates(command, platform, env) {
  if (path.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return [command];
  }
  const extensions =
    platform === "win32" && path.extname(command) === ""
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
      : [""];
  return pathValue(env)
    .split(path.delimiter)
    .filter(Boolean)
    .flatMap((directory) =>
      extensions.map((extension) => path.join(directory, command + extension)),
    );
}

function isExecutable(candidate, platform) {
  try {
    fs.accessSync(candidate, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export function resolveClaudeCommand({ env = process.env, platform = process.platform } = {}) {
  const configured = env.CODEXHOST_CLAUDE_COMMAND;
  const source = configured ? "environment" : "path";
  const command = configured || "claude";
  const resolved = executableCandidates(command, platform, env).find((candidate) =>
    isExecutable(candidate, platform),
  );
  if (!resolved) {
    const error = new Error(`Claude Code executable is not available from ${source}`);
    error.code = "CLAUDE_NOT_FOUND";
    throw error;
  }
  return { executable: path.resolve(resolved), source };
}

export function sanitizedAuthStatus(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Claude auth status must be a JSON object");
  }
  return {
    loggedIn: value.loggedIn === true,
    authMethod:
      typeof value.authMethod === "string" && value.authMethod.length > 0
        ? value.authMethod
        : "unknown",
    apiProvider:
      typeof value.apiProvider === "string" && value.apiProvider.length > 0
        ? value.apiProvider
        : "unknown",
  };
}
