import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { commandInvocation } from "@codexhost/harness-discovery";
import { resolveOpenCodeExecutable } from "./command.js";
import type { OpenCodeServerOptions } from "./server-connection.js";

const VERSION_OUTPUT = /^(?:(?:opencode|cli)\s+)?v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)$/iu;

/** OpenCode 1.x prints plain SemVer ("1.19.6"); 2.x prefixes it ("opencode v2.4.1" or "CLI 2.4.1"). */
export function openCodeVersion(output: string): string {
  const match = VERSION_OUTPUT.exec(output.trim());
  if (!match?.[1]) throw new Error(`Unsupported OpenCode version: ${output.trim().slice(0, 100)}`);
  return match[1];
}

export function openCodeMajor(version: string): 1 | 2 {
  const parsed = openCodeVersion(version);
  if (parsed.startsWith("1.")) return 1;
  if (parsed.startsWith("2.")) return 2;
  throw new Error(`Unsupported OpenCode version: ${version.trim().slice(0, 100)}`);
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
