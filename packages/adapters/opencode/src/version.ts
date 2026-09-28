import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { commandInvocation } from "@codexhost/harness-discovery";
import { resolveOpenCodeExecutable } from "./command.js";
import type { OpenCodeServerOptions } from "./server-connection.js";

export function openCodeMajor(version: string): 1 | 2 {
  const match = /^(?:opencode\s+)?v?([12])\.\d+\.\d+(?:[-+][\w.-]+)?$/u.exec(version.trim());
  if (!match) throw new Error(`Unsupported OpenCode version: ${version.trim().slice(0, 100)}`);
  return match[1] === "1" ? 1 : 2;
}

export async function detectOpenCode(options: OpenCodeServerOptions) {
  const environment = options.environment ?? process.env;
  const executable = resolveOpenCodeExecutable({
    ...(options.command ? { command: options.command } : {}),
    environment,
  });
  const invocation = commandInvocation(executable, ["--version"], environment);
  const { stdout } = await promisify(execFile)(invocation.command, invocation.arguments, {
    env: environment,
    timeout: options.startupTimeoutMs ?? 20_000,
    maxBuffer: 16_384,
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  return { executable, major: openCodeMajor(stdout) };
}
