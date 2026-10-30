import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { commandInvocation } from "@codexhost/harness-discovery";

/** A legacy interpreter, or the installation-bound launcher that owns its bootstrap. */
export type HermesPythonRuntime = string | { launcher: string };
export interface HermesPythonCommand {
  command: string;
  arguments: string[];
}

export function legacyHermesPythonCommand(python: string, script: string): HermesPythonCommand {
  return {
    command: python,
    arguments: [
      "-I",
      "-u",
      "-c",
      `import importlib.util\nif importlib.util.find_spec('hermes_bootstrap') is not None:\n    import hermes_bootstrap\n${script}`,
    ],
  };
}

/** Ask Hermes to construct the command; never reconstruct or strip its bootstrap. */
export async function nativeHermesPythonCommand(
  launcher: string,
  script: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs = 20_000,
  platform: NodeJS.Platform = process.platform,
): Promise<HermesPythonCommand | null> {
  const invocation = commandInvocation(
    launcher,
    [
      "--print-runtime-command",
      "--module",
      "timeit",
      "--",
      "-n",
      "1",
      "-r",
      "1",
      "-s",
      // timeit is a stdlib entry point supported by the native launcher. After
      // the operation returns, redirect its timing footer, preserving normal
      // native cleanup and exit status without contaminating JSON/RPC stdout.
      `exec(${JSON.stringify(script)}, {}); import sys, io; sys.stdout = io.StringIO()`,
      "pass",
    ],
    environment,
    platform,
  );
  let stdout: string;
  try {
    ({ stdout } = await promisify(execFile)(invocation.command, invocation.arguments, {
      env: environment,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      /unknown option|unrecognized arguments|unsupported option|unexpected argument/i.test(message)
    )
      return null;
    throw error;
  }
  const value: unknown = JSON.parse(stdout.trim());
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((arg) => typeof arg === "string") ||
    !value[0]
  ) {
    throw new Error("Hermes launcher returned an invalid runtime command");
  }
  return { command: value[0], arguments: value.slice(1) };
}

export async function hermesPythonCommand(
  runtime: HermesPythonRuntime,
  script: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs = 20_000,
): Promise<HermesPythonCommand> {
  if (typeof runtime === "string") return legacyHermesPythonCommand(runtime, script);
  const command = await nativeHermesPythonCommand(runtime.launcher, script, environment, timeoutMs);
  if (!command)
    throw new Error("Hermes selected runtime no longer supports its native launch interface");
  return command;
}
