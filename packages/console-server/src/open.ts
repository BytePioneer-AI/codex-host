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
 * Ensures the requested console installation and build answer on the configured
 * port, restarting a previous instance when needed. Returns the confirmed port.
 */
export async function ensureConsole(
  options: Pick<OpenConsoleOptions, "appDirectory" | "entryPath" | "environment">,
): Promise<{ port: number }> {
  const environment = options.environment ?? process.env;
  const port = consolePort(environment);

  let probe = await probeConsole(port);
  // Another installation, or this installation after an update, replaces the console.
  const ownBuildId = await consoleBuildId(options.entryPath);
  const matches = (next: ConsoleProbe): boolean =>
    next.kind === "console" &&
    next.appDirectory === options.appDirectory &&
    next.buildId === ownBuildId;
  if (probe.kind === "console" && !matches(probe)) {
    // A concurrent opener may have replaced the old instance while we read the build.
    probe = await probeConsole(port);
    if (probe.kind === "console" && !matches(probe)) {
      await requestShutdown(port).catch(() => undefined);
      probe = await waitFor(port, (next) => next.kind !== "console" || matches(next), 5_000);
    }
  }
  if (probe.kind === "foreign") {
    throw new Error(
      `port ${port} is used by another program; set ${CONSOLE_PORT_ENV} to a free port and retry`,
    );
  }
  if (probe.kind === "console" && !matches(probe)) {
    throw new Error(
      `codexhost console on port ${port} did not stop for the requested installation`,
    );
  }
  if (probe.kind === "free") {
    startDetachedServer(options.entryPath, environment);
    probe = await waitFor(port, matches, 10_000);
  }
  if (!matches(probe)) {
    throw new Error(
      `codexhost console did not start on port ${port} for the requested installation`,
    );
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
