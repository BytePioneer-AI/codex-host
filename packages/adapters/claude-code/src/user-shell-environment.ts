import path from "node:path";
import { execFile } from "node:child_process";

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
  ): Promise<ShellEnvironmentRunResult>;
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

const CLAUDE_NESTED_SESSION_ENV_NAMES = new Set<string>([
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_PID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_EFFORT",
]);

export function isClaudeToolchainVariable(name: string): boolean {
  return (
    name.startsWith("ANTHROPIC_") ||
    name === "CLAUDE_CODE_SUBAGENT_MODEL" ||
    name === "CLAUDE_CODE_MAX_CONTEXT_TOKENS" ||
    name === "CLAUDE_CODE_AUTO_MODE_SERVER"
  );
}

function isNestedSessionVariable(name: string): boolean {
  return CLAUDE_NESTED_SESSION_ENV_NAMES.has(name);
}

function withoutVariables(
  environment: NodeJS.ProcessEnv,
  excluded: (name: string) => boolean,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(([name, value]) => value !== undefined && !excluded(name)),
  );
}

export function stripNestedSessionEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return withoutVariables(environment, isNestedSessionVariable);
}

/**
 * Seed the login-shell probe with Host variables the user's rc files may build on (PATH,
 * HOME, locale), but never the Claude toolchain or nested-session variables: anything of
 * those classes observed after startup was set by the user's own shell configuration.
 */
function shellProbeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return withoutVariables(
    environment,
    (name) => isClaudeToolchainVariable(name) || isNestedSessionVariable(name),
  );
}

function mergeEnvironmentWithShellSnapshot(
  environment: NodeJS.ProcessEnv,
  shellEnvironment: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  // Toolchain and model slot variables: the login-shell snapshot is the authoritative
  // source because the probe never seeds them. Values present only in the Host process
  // are ambient inheritance (a wrapper script or nested session exported them), so they
  // are dropped instead of silently rerouting the default claude-code instance.
  const merged = withoutVariables(
    environment,
    (name) => isNestedSessionVariable(name) || isClaudeToolchainVariable(name),
  );
  for (const [name, value] of Object.entries(shellEnvironment)) {
    if (merged[name] === undefined) merged[name] = value;
  }
  return merged;
}

/**
 * GUI applications do not load the user's shell initialization files. Capture them once
 * for Claude Code without parsing shell syntax or overriding the Host process environment.
 * The snapshot is never persisted or logged. Claude toolchain variables (`ANTHROPIC_*`,
 * model slots) survive only when the user's own shell configuration exports them; values
 * ambient in the Host process are dropped so a wrapper-launched Host cannot reroute the
 * default instance. Nested-session variables (`CLAUDECODE`, `CLAUDE_CODE_*`, …) are always
 * stripped so a Claude Code child never believes it is nested inside another session.
 */
export async function withUserShellEnvironment(
  environment: NodeJS.ProcessEnv,
  dependencies?: UserShellEnvironmentDependencies,
): Promise<NodeJS.ProcessEnv> {
  const platform = dependencies?.platform ?? process.platform;
  if (platform === "win32" || !environment.HOME) return stripNestedSessionEnvironment(environment);
  const shell = environment.SHELL?.trim() || defaultShell(platform);
  if (!shell || !SUPPORTED_SHELLS.has(path.basename(shell))) {
    return stripNestedSessionEnvironment(environment);
  }

  const cacheKey = `${platform}\0${shell}\0${environment.HOME}`;
  const cached = dependencies ? undefined : shellEnvironmentCache.get(cacheKey);
  if (cached) return mergeEnvironmentWithShellSnapshot(environment, cached);

  const run =
    dependencies?.run ??
    ((command: string, arguments_: readonly string[], options) =>
      new Promise<ShellEnvironmentRunResult>((resolve) => {
        const child = execFile(
          command,
          arguments_,
          {
            ...options,
            encoding: "buffer",
            killSignal: "SIGKILL",
          },
          (error, stdout) => resolve({ status: error ? 1 : 0, stdout }),
        );
        child.stdin?.end();
      }));
  try {
    const result = await run(shell, ["-ilc", ENVIRONMENT_COMMAND], {
      env: shellProbeEnvironment(environment),
      maxBuffer: SHELL_ENVIRONMENT_MAX_BYTES,
      timeout: SHELL_ENVIRONMENT_TIMEOUT_MS,
      windowsHide: true,
    });
    const loaded = result.status === 0 ? parseEnvironment(result.stdout) : null;
    if (!loaded) return stripNestedSessionEnvironment(environment);
    if (!dependencies) shellEnvironmentCache.set(cacheKey, loaded);
    return mergeEnvironmentWithShellSnapshot(environment, loaded);
  } catch {
    return stripNestedSessionEnvironment(environment);
  }
}
