import { spawn } from "node:child_process";

/**
 * `session/steer` exists from 2.134.0. The `{steered}` acceptance receipt, which
 * `turn.steer` needs before it can return `accepted`, exists from 2.143.1.
 */
export const CODEBUDDY_STEER_MIN_VERSION = "2.143.1";

export interface CodeBuddySteerResult {
  steered: boolean;
  reason?: string;
}

export function compareCodeBuddyVersion(left: string, right: string): number {
  const a = left.split(".").map((part) => Number(part));
  const b = right.split(".").map((part) => Number(part));
  for (let index = 0; index < 3; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/** Product versions are unprefixed semver. A leading `v` is Node or Electron, not CodeBuddy. */
export function parseCodeBuddyProductVersion(output: string): string | null {
  const line = output
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (!line) return null;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(line);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

export function codeBuddySupportsSteer(version: string | null | undefined): boolean {
  return (
    typeof version === "string" &&
    compareCodeBuddyVersion(version, CODEBUDDY_STEER_MIN_VERSION) >= 0
  );
}

/**
 * Real CodeBuddy and WorkBuddy ACP invocations include `--acp`. The unit-test
 * ACP fixture does not, so it is not probed. A positional argument is the
 * bundled CLI path (`electron <cli> --acp`); `--version` replaces the ACP flags.
 */
export function codeBuddyVersionProbeArguments(args: readonly string[]): string[] | null {
  if (!args.includes("--acp")) return null;
  const script = args.find((arg) => !arg.startsWith("-"));
  return script ? [script, "--version"] : ["--version"];
}

export function probeCodeBuddyProductVersion(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs = 3_000,
): Promise<string | null> {
  const probeArgs = codeBuddyVersionProbeArguments(args);
  if (!probeArgs) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = spawn(command, probeArgs, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let stdout = "";
    let settled = false;
    const finish = (version: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(version);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 512) child.kill("SIGKILL");
    });
    child.on("error", () => finish(null));
    child.on("close", () => finish(parseCodeBuddyProductVersion(stdout)));
  });
}
