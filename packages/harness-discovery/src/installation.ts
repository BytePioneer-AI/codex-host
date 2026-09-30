import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { commandInvocation } from "./invocation.js";
import { withNodeRuntimeOnPath } from "./node-runtime.js";

export interface InstallationState {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  canUpdate: boolean;
  message?: string;
}

/** Fixed adapter-owned commands only. No shell, prompt input, or raw output in errors. */
export function runInstallationCommand(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  timeout = 30_000,
): Promise<string> {
  const env = withNodeRuntimeOnPath(environment);
  const invocation = /\.[cm]?js$/i.test(command)
    ? commandInvocation(process.execPath, [command, ...args], env)
    : commandInvocation(command, args, env);
  return new Promise((resolve, reject) => {
    const child = execFile(
      invocation.command,
      invocation.arguments,
      {
        env,
        cwd: env.HOME ?? env.USERPROFILE ?? homedir(),
        encoding: "utf8",
        timeout,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new Error(
              error.killed
                ? "Harness command timed out"
                : "Harness command failed; check the native installation and retry",
            ),
          );
        else resolve((stdout || stderr).trim());
      },
    );
    child.stdin?.end();
  });
}

export function installationVersion(value: unknown): string {
  if (typeof value !== "string" || !/^v?\d+(?:\.\d+){1,3}(?:[-+][\w.-]+)?$/.test(value.trim()))
    throw new Error("Harness returned an invalid version");
  return value.trim().replace(/^v/, "");
}

export function versionFromOutput(output: string): string {
  return installationVersion(output.match(/\b\d+(?:\.\d+){1,3}(?:[-+][\w.-]+)?\b/)?.[0]);
}

/** Stable releases only; a newer local build must not be downgraded. */
export function newerInstallationVersion(current: string, latest: string): boolean {
  const a = installationVersion(current).split(/[.+-]/).slice(0, 3).map(Number);
  const b = installationVersion(latest).split(/[.+-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (b[i] ?? 0) > (a[i] ?? 0);
  }
  return current.includes("-") && !latest.includes("-");
}

/** Concurrent clicks share one update; checks cannot race its readback. */
export function createInstallationManager(options: {
  check(): Promise<InstallationState>;
  update(state: InstallationState): Promise<void>;
}) {
  let checking: Promise<InstallationState> | undefined;
  let updating: Promise<InstallationState> | undefined;
  const check = () =>
    (checking ??= options.check().finally(() => {
      checking = undefined;
    }));
  return (action: "check" | "update"): Promise<InstallationState> => {
    if (updating) return updating;
    if (action === "check") return check();
    updating = (async () => {
      const before = await check();
      if (!before.updateAvailable) return before;
      if (!before.canUpdate)
        throw new Error(before.message ?? "This installation cannot be updated automatically");
      await options.update(before);
      const after = await check();
      if (after.currentVersion === before.currentVersion)
        throw new Error("The Harness version did not change; check the native updater and retry");
      return after;
    })().finally(() => {
      updating = undefined;
    });
    return updating;
  };
}

export async function fetchInstallationText(url: string): Promise<string> {
  const request = async () => {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error("Could not check the latest Harness version");
    return response.text();
  };
  try {
    return await request();
  } catch (error) {
    if (
      error instanceof DOMException &&
      (error.name === "AbortError" || error.name === "TimeoutError")
    )
      throw error;
    return request();
  }
}
