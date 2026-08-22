import type { Writable } from "node:stream";

import {
  inspectRemoteHostInstallation,
  installRemoteHost,
  type RemoteHostInstallOptions,
  uninstallRemoteHost,
} from "./remote-host-install.js";

interface RemoteCliResources {
  nodePath?: string;
  shimPath?: string;
  hostRuntimePath?: string;
}

function parseRemoteCliArguments(arguments_: readonly string[]): {
  command: "install" | "status" | "uninstall" | "help";
  options: RemoteHostInstallOptions;
} {
  const command = arguments_[0];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    return { command: "help", options: {} };
  }
  if (command !== "install" && command !== "status" && command !== "uninstall") {
    throw new Error(`Unknown remote command '${command}'`);
  }
  const options: RemoteHostInstallOptions = {};
  const resources: RemoteCliResources = {};
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (!value) throw new Error(`${argument} requires a value`);
    switch (argument) {
      case "--install-root":
        options.installRoot = value;
        break;
      case "--profile":
        options.profilePath = value;
        break;
      case "--stock-codex":
        options.stockCodexPath = value;
        break;
      case "--claude-command":
        options.claudeCommand = value;
        break;
      case "--node":
        resources.nodePath = value;
        break;
      case "--shim":
        resources.shimPath = value;
        break;
      case "--host-runtime":
        resources.hostRuntimePath = value;
        break;
      default:
        throw new Error(`Unknown remote option '${argument}'`);
    }
    index += 1;
  }
  return { command, options: { ...options, ...resources } };
}

export async function runRemoteHostCli(input: {
  arguments: string[];
  environment?: NodeJS.ProcessEnv;
  output?: Writable;
  diagnosticOutput?: Writable;
}): Promise<number> {
  const output = input.output ?? process.stdout;
  const diagnosticOutput = input.diagnosticOutput ?? process.stderr;
  try {
    const parsed = parseRemoteCliArguments(input.arguments);
    const options = { ...parsed.options, environment: input.environment ?? process.env };
    if (parsed.command === "help") {
      output.write(
        [
          "usage:",
          "  codexhost remote install [--stock-codex PATH] [--claude-command PATH]",
          "  codexhost remote status",
          "  codexhost remote uninstall",
          "",
          "Installs a managed Codex entrypoint for Codex Desktop SSH sessions.",
        ].join("\n") + "\n",
      );
      return 0;
    }
    if (parsed.command === "install") {
      const result = await installRemoteHost(options);
      output.write(`${JSON.stringify({ state: "ready", ...result }, null, 2)}\n`);
      return 0;
    }
    if (parsed.command === "status") {
      const result = await inspectRemoteHostInstallation(options);
      output.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.state === "degraded" ? 1 : 0;
    }
    await uninstallRemoteHost(options);
    output.write(`${JSON.stringify({ state: "not-installed" }, null, 2)}\n`);
    return 0;
  } catch (error) {
    diagnosticOutput.write(
      `codexhost remote: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}
