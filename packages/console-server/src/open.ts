import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";

import { consoleBundleCandidates } from "./page.js";
import { CONSOLE_REQUEST_HEADER } from "./request-guard.js";
import { CONSOLE_PORT_ENV, consolePort } from "./paths.js";
import { CONSOLE_SERVICE } from "./server.js";

export type ConsoleProbe =
  | { kind: "console"; appDirectory: string; pid: number; buildId: string | null }
  | { kind: "free" }
  | { kind: "foreign" };

function refused(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if ((current as NodeJS.ErrnoException).code === "ECONNREFUSED") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export async function probeConsole(port: number): Promise<ConsoleProbe> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1_500),
    });
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (
      response.ok &&
      body?.service === CONSOLE_SERVICE &&
      typeof body.appDirectory === "string" &&
      typeof body.pid === "number"
    ) {
      return {
        kind: "console",
        appDirectory: body.appDirectory,
        pid: body.pid,
        buildId: typeof body.buildId === "string" ? body.buildId : null,
      };
    }
    return { kind: "foreign" };
  } catch (error) {
    return refused(error) ? { kind: "free" } : { kind: "foreign" };
  }
}

async function waitFor(
  port: number,
  accept: (probe: ConsoleProbe) => boolean,
  timeoutMs: number,
): Promise<ConsoleProbe> {
  const deadline = Date.now() + timeoutMs;
  let probe = await probeConsole(port);
  while (!accept(probe) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    probe = await probeConsole(port);
  }
  return probe;
}

async function requestShutdown(port: number): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
    method: "POST",
    headers: { [CONSOLE_REQUEST_HEADER]: "1" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`console shutdown failed: HTTP ${response.status}`);
}

/** Stops only this installation's console. The server verifies the observed
 * instance again at shutdown, so a port changing owners cannot stop another
 * installation. An older server without this route leaves the update blocked.
 */
export async function stopConsoleForUpdate(options: {
  appDirectory: string;
  environment?: NodeJS.ProcessEnv;
}): Promise<void> {
  const port = consolePort(options.environment ?? process.env);
  const probe = await probeConsole(port);
  if (probe.kind === "foreign") {
    throw new Error("console instance could not be identified before update");
  }
  if (probe.kind === "free" || probe.appDirectory !== options.appDirectory) return;
  if (!Number.isSafeInteger(probe.pid) || probe.pid <= 0) {
    throw new Error("console returned an invalid process ID");
  }
  const response = await fetch(`http://127.0.0.1:${port}/api/shutdown-for-update`, {
    method: "POST",
    headers: { [CONSOLE_REQUEST_HEADER]: "1", "content-type": "application/json" },
    body: JSON.stringify({ expectedPid: probe.pid, expectedAppDirectory: options.appDirectory }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`console update shutdown failed: HTTP ${response.status}`);
  const deadline = Date.now() + 5_000;
  while (processIsAlive(probe.pid)) {
    if (Date.now() >= deadline) throw new Error("console did not exit before update");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    // Permission errors and unexpected failures cannot prove it exited.
    return true;
  }
}

export interface OpenConsoleOptions {
  appDirectory: string;
  entryPath: string;
  environment?: NodeJS.ProcessEnv;
  launcherExecutable: string | null;
  /** False returns the address without opening a browser. */
  browser?: boolean;
}

/** Changes whenever the console server or its page bundle is replaced (update, rebuild). */
export async function consoleBuildId(entryPath: string): Promise<string> {
  const files = [entryPath, ...consoleBundleCandidates(path.dirname(entryPath))];
  const parts: string[] = [];
  for (const file of files) {
    const metadata = await stat(file).catch(() => null);
    if (metadata) parts.push(`${Math.trunc(metadata.mtimeMs)}-${metadata.size}`);
  }
  return parts.join(".");
}

function startDetachedServer(entryPath: string, environment: NodeJS.ProcessEnv): void {
  const child = spawn(process.execPath, [entryPath, "serve"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: environment,
  });
  child.unref();
}

/** Opens a loopback URL through the Launcher, which validates it first. */
function openWithLauncher(launcherExecutable: string, url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(launcherExecutable, ["open-loopback-url"], {
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
    child.stdin.end(url);
  });
}

/**
 * Ensures exactly one console answers on the configured port, restarting it
 * when it belongs to a different installation. Returns the port.
 */
export async function ensureConsole(
  options: Pick<OpenConsoleOptions, "appDirectory" | "entryPath" | "environment">,
): Promise<{ port: number }> {
  const environment = options.environment ?? process.env;
  const port = consolePort(environment);

  let probe = await probeConsole(port);
  // Another installation, or this installation after an update, replaces the console.
  const ownBuildId = await consoleBuildId(options.entryPath);
  if (
    probe.kind === "console" &&
    (probe.appDirectory !== options.appDirectory || probe.buildId !== ownBuildId)
  ) {
    await requestShutdown(port).catch(() => undefined);
    probe = await waitFor(port, (next) => next.kind !== "console", 5_000);
  }
  if (probe.kind === "foreign") {
    throw new Error(
      `port ${port} is used by another program; set ${CONSOLE_PORT_ENV} to a free port and retry`,
    );
  }
  if (probe.kind === "free") {
    startDetachedServer(options.entryPath, environment);
    probe = await waitFor(port, (next) => next.kind === "console", 10_000);
    if (probe.kind !== "console") {
      throw new Error(`codexhost console did not start on port ${port}`);
    }
  }
  return { port };
}

/** The overview includes startup and integration failure diagnostics. */
export function consoleUrl(port: number): string {
  return `http://127.0.0.1:${port}/`;
}

/** Ensures the console, opens it unless `browser` is false, and returns its address. */
export async function openConsole(options: OpenConsoleOptions): Promise<string> {
  const { port } = await ensureConsole(options);
  const url = consoleUrl(port);
  if (options.browser !== false && options.launcherExecutable) {
    await openWithLauncher(options.launcherExecutable, url);
  }
  return url;
}
