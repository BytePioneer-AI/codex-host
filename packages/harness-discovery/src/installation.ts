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
  if (
    typeof value !== "string" ||
    !/^v?\d+(?:\.\d+){1,3}(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(value.trim())
  )
    throw new Error("Harness returned an invalid version");
  return value.trim().replace(/^v/, "");
}

export function versionFromOutput(output: string): string {
  return installationVersion(output.match(/\b\d+(?:\.\d+){1,3}(?:-[\w.-]+)?(?:\+[\w.-]+)?\b/)?.[0]);
}

/** Preserve release/prerelease ordering; build metadata does not select an update. */
export function newerInstallationVersion(current: string, latest: string): boolean {
  const a = installationVersion(current).replace(/\+.*/, "");
  const b = installationVersion(latest).replace(/\+.*/, "");
  const coreA = a.replace(/-.*/, "").split(".").map(BigInt);
  const coreB = b.replace(/-.*/, "").split(".").map(BigInt);
  for (let i = 0; i < Math.max(coreA.length, coreB.length); i++) {
    if ((coreA[i] ?? 0n) !== (coreB[i] ?? 0n)) return (coreB[i] ?? 0n) > (coreA[i] ?? 0n);
  }
  const preA = a.includes("-") ? a.slice(a.indexOf("-") + 1).split(".") : [];
  const preB = b.includes("-") ? b.slice(b.indexOf("-") + 1).split(".") : [];
  if (!preA.length || !preB.length) return !!preA.length && !preB.length;
  for (let i = 0; i < Math.max(preA.length, preB.length); i++) {
    const x = preA[i];
    const y = preB[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined;
    const numericX = /^\d+$/.test(x);
    const numericY = /^\d+$/.test(y);
    if (numericX && numericY) {
      if (BigInt(x) === BigInt(y)) continue;
      return BigInt(y) > BigInt(x);
    }
    if (numericX !== numericY) return numericX;
    return y > x;
  }
  return false;
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
