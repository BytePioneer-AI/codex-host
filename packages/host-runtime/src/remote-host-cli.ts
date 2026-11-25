import type { Writable } from "node:stream";

import {
  installRemoteHost,
  type RemoteHostInstallOptions,
  uninstallRemoteHost,
} from "./remote-host-install.js";
import { inspectRemoteHost, startRemoteHost, stopRemoteHost } from "./remote-host-lifecycle.js";

interface RemoteCliResources {
  nodePath?: string;
  shimPath?: string;
  hostRuntimePath?: string;
}

function parseRemoteCliArguments(arguments_: readonly string[]): {
  command: "install" | "start" | "stop" | "status" | "uninstall" | "help";
  options: RemoteHostInstallOptions;
} {
  const command = arguments_[0];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    return { command: "help", options: {} };
  }
  if (
    command !== "install" &&
    command !== "start" &&
    command !== "stop" &&
    command !== "status" &&
    command !== "uninstall"
  ) {
    throw new Error(`Unknown remote command '${command}'`);
  }
  const options: RemoteHostInstallOptions = {};
  const resources: RemoteCliResources = {};
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (!value) throw new Error(`${argument} requires a value`);
    switch (argument) {
      case "--session":
        if (command !== "install" || (value !== "ssh" && value !== "desktop")) {
          throw new Error("Use remote install --session ssh|desktop");
        }
        options.executionSession = value;
        break;
      case "--install-root":
        options.installRoot = value;
        break;
      case "--shared-data":
        options.sharedDataDirectory = value;
        break;
      case "--profile":
        options.profilePath = value;
        break;
      case "--stock-codex":
        options.stockCodexPath = value;
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
          "  codexhost remote install [--stock-codex PATH] [--shared-data DIRECTORY] [--session ssh|desktop]",
          "  codexhost remote start",
          "  codexhost remote stop",
          "  codexhost remote status",
          "  codexhost remote uninstall",
          "",
          "Installs and manages a headless codexhost Remote Host for SSH sessions.",
          "On macOS, --session desktop uses the logged-in desktop keychain. Locking the screen is supported; logging out stops its tasks.",
        ].join("\n") + "\n",
      );
      return 0;
    }
    if (parsed.command === "install") {
      const result = await installRemoteHost(options);
      output.write(`${JSON.stringify({ state: "ready", ...result }, null, 2)}\n`);
      return 0;
    }
    if (parsed.command === "start") {
      const result = await startRemoteHost(options);
      output.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    if (parsed.command === "stop") {
      const result = await stopRemoteHost(options);
      output.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    if (parsed.command === "status") {
      const result = await inspectRemoteHost(options);
      output.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.state === "degraded" || result.runtime.state === "unknown" ? 1 : 0;
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
