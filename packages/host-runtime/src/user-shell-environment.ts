import path from "node:path";
import { spawnSync } from "node:child_process";

const ENVIRONMENT_MARKER = Buffer.from("\0CODEXHOST_USER_SHELL_ENV_V1\0");
const ENVIRONMENT_COMMAND = "printf '\\0CODEXHOST_USER_SHELL_ENV_V1\\0'; /usr/bin/env -0";
const SHELL_ENVIRONMENT_TIMEOUT_MS = 3_000;
const SHELL_ENVIRONMENT_MAX_BYTES = 2 * 1024 * 1024;
const SUPPORTED_SHELLS = new Set(["bash", "fish", "zsh"]);

interface ShellEnvironmentRunResult {
  readonly status: number | null;
  readonly stdout: Buffer | string;
}

interface UserShellEnvironmentDependencies {
  readonly platform?: NodeJS.Platform;
  run(
    command: string,
    arguments_: readonly string[],
    options: {
      env: NodeJS.ProcessEnv;
      maxBuffer: number;
      timeout: number;
      windowsHide: boolean;
    },
  ): ShellEnvironmentRunResult;
}

const shellEnvironmentCache = new Map<string, Readonly<Record<string, string>>>();

function defaultShell(platform: NodeJS.Platform): string | null {
  if (platform === "darwin") return "/bin/zsh";
  if (platform === "linux") return "/bin/bash";
  return null;
}

function parseEnvironment(output: Buffer | string): Record<string, string> | null {
  const bytes = Buffer.isBuffer(output) ? output : Buffer.from(output);
  const markerIndex = bytes.indexOf(ENVIRONMENT_MARKER);
  if (markerIndex < 0) return null;
  const environment: Record<string, string> = {};
  const entries = bytes
    .subarray(markerIndex + ENVIRONMENT_MARKER.length)
    .toString()
    .split("\0");
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    environment[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return environment;
}

function mergeMissingEnvironment(
  environment: NodeJS.ProcessEnv,
  shellEnvironment: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const merged = { ...environment };
  for (const [name, value] of Object.entries(shellEnvironment)) {
    if (merged[name] === undefined) merged[name] = value;
  }
  return merged;
}

/**
 * GUI applications do not load the user's shell initialization files. Capture
 * them once for Claude Code without parsing shell syntax or overriding the Host
 * process environment. The snapshot is never persisted or logged.
 */
export function withUserShellEnvironment(
  environment: NodeJS.ProcessEnv,
  dependencies?: UserShellEnvironmentDependencies,
): NodeJS.ProcessEnv {
  const platform = dependencies?.platform ?? process.platform;
  if (platform === "win32" || !environment.HOME) return environment;
  const shell = environment.SHELL?.trim() || defaultShell(platform);
  if (!shell || !SUPPORTED_SHELLS.has(path.basename(shell))) return environment;

  const cacheKey = `${platform}\0${shell}\0${environment.HOME}`;
  const cached = dependencies ? undefined : shellEnvironmentCache.get(cacheKey);
  if (cached) return mergeMissingEnvironment(environment, cached);

  const run =
    dependencies?.run ??
    ((command: string, arguments_: readonly string[], options) =>
      spawnSync(command, arguments_, {
        ...options,
        encoding: "buffer",
        stdio: ["ignore", "pipe", "ignore"],
      }));
  try {
    const result = run(shell, ["-ilc", ENVIRONMENT_COMMAND], {
      env: environment,
      maxBuffer: SHELL_ENVIRONMENT_MAX_BYTES,
      timeout: SHELL_ENVIRONMENT_TIMEOUT_MS,
      windowsHide: true,
    });
    const loaded = result.status === 0 ? parseEnvironment(result.stdout) : null;
    if (!loaded) return environment;
    if (!dependencies) shellEnvironmentCache.set(cacheKey, loaded);
    return mergeMissingEnvironment(environment, loaded);
  } catch {
    return environment;
  }
}
