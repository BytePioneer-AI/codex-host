import fs from "node:fs";
import path from "node:path";

import { GateCError } from "./errors.mjs";

function validateCommandArray(command) {
  if (!Array.isArray(command) || command.length === 0) {
    throw new GateCError("INVALID_COMMAND", "configuredCommand must be a non-empty argv array");
  }
  if (command.some((part) => typeof part !== "string" || part.length === 0)) {
    throw new GateCError(
      "INVALID_COMMAND",
      "configuredCommand argv entries must be non-empty strings",
    );
  }
  return [...command];
}

export function resolvePiCommand({ configuredCommand, env = process.env } = {}) {
  if (configuredCommand !== undefined) {
    const [command, ...prefixArgs] = validateCommandArray(configuredCommand);
    return { command, prefixArgs, source: "configured" };
  }
  if (env.PI_COMMAND !== undefined && env.PI_COMMAND.length > 0) {
    return { command: env.PI_COMMAND, prefixArgs: [], source: "environment" };
  }
  return { command: "pi", prefixArgs: [], source: "path" };
}

function quoteCmdArgument(value) {
  const escaped = value.replaceAll("%", "%%").replaceAll('"', '""');
  return `"${escaped}"`;
}

export function buildPiInvocation({ configuredCommand, env, rpcArgs = [] } = {}) {
  const selected = resolvePiCommand({ configuredCommand, env });
  const args = [...selected.prefixArgs, "--mode", "rpc", ...rpcArgs];
  return { ...selected, args };
}

function windowsPathValue(env) {
  const key = Object.keys(env).find((name) => name.toLowerCase() === "path");
  return key ? env[key] : undefined;
}

function resolveWindowsCommand(command, env) {
  if (path.isAbsolute(command) || command.includes("/") || command.includes("\\")) return command;
  const extensions = path.extname(command)
    ? [""]
    : (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";");
  for (const directory of (windowsPathValue(env) ?? "").split(path.delimiter)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension.toLowerCase()}`);
      if (fs.existsSync(candidate)) return candidate;
      const upperCandidate = path.join(directory, `${command}${extension.toUpperCase()}`);
      if (fs.existsSync(upperCandidate)) return upperCandidate;
    }
  }
  return command;
}

export function prepareSpawn(invocation, { platform = process.platform, env = process.env } = {}) {
  const command =
    platform === "win32" ? resolveWindowsCommand(invocation.command, env) : invocation.command;
  const extension = path.extname(command).toLowerCase();
  if (platform !== "win32" || ![".cmd", ".bat"].includes(extension)) {
    return { command, args: invocation.args, windowsVerbatimArguments: false };
  }

  const commandInterpreter = env.ComSpec ?? env.COMSPEC ?? "cmd.exe";
  const commandLine = [command, ...invocation.args].map(quoteCmdArgument).join(" ");
  return {
    command: commandInterpreter,
    args: ["/d", "/v:off", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}
