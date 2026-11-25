import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { promisify } from "node:util";
import { commandInvocation } from "@codexhost/harness-discovery";

/** A legacy interpreter, or the installation-bound launcher that owns its bootstrap. */
export type HermesPythonRuntime = string | { launcher: string };
export interface HermesPythonCommand {
  command: string;
  arguments: string[];
}

// `--print-runtime-command` answers depend only on the launcher binary and the
// python-steering environment — not on the embedded script — but each probe is
// a full interpreter start (~0.3s). Cache the launcher prefix (python + `-I` +
// `-c` bootstrap) so every later spawn skips the round trip; the passthrough
// timeit arguments are re-appended by the caller. Keyed on the launcher's stat
// so a `hermes update` that rewrites it invalidates the entry.
const launcherPrefixCache = new Map<string, string[]>();
function launcherCacheKey(launcher: string, environment: NodeJS.ProcessEnv): string | null {
  let stat: { mtimeMs: number; size: number };
  try {
    stat = statSync(launcher);
  } catch {
    return null;
  }
  return [
    launcher,
    stat.mtimeMs,
    stat.size,
    environment.HERMES_HOME ?? "",
    environment.PATH ?? "",
  ].join("\u0000");
}
function timeitPassthrough(script: string): string[] {
  return [
    "-n",
    "1",
    "-r",
    "1",
    "-s",
    `exec(${JSON.stringify(script)}, {}); import sys, io; sys.stdout = io.StringIO()`,
    "pass",
  ];
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
  const passthrough = timeitPassthrough(script);
  // Fast path: the launcher prefix (interpreter + `-I` + `-c` bootstrap) is
  // script-independent, so a cached entry answers without spawning the probe.
  const cacheKey = launcherCacheKey(launcher, environment);
  const cached = cacheKey !== null ? launcherPrefixCache.get(cacheKey) : undefined;
  if (cached !== undefined && cached.length > 0 && cached[0])
    return { command: cached[0], arguments: [...cached.slice(1), ...passthrough] };
  const invocation = commandInvocation(
    launcher,
    ["--print-runtime-command", "--module", "timeit", "--", ...passthrough],
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
  // The launcher echoes the timeit arguments back verbatim; the prefix before
  // them is what a cache hit replays. Cache only when that shape holds.
  const passthroughStart = value.length - passthrough.length;
  if (
    cacheKey !== null &&
    passthroughStart >= 1 &&
    value.slice(passthroughStart).every((arg, index) => arg === passthrough[index])
  )
    launcherPrefixCache.set(cacheKey, value.slice(0, passthroughStart));
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
