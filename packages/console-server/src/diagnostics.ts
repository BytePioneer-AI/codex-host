import { open, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const MAX_DIAGNOSTIC_FILE_BYTES = 256 * 1024;
export const MAX_LOG_TAIL_BYTES = 256 * 1024;
const LOG_FILE_PATTERN = /^host-runtime-\d{1,10}\.log(?:\.1)?$/u;

export interface StartupStage {
  name: string;
  elapsedMs: number;
}

export interface StartupRecord {
  id: string;
  pid: number;
  launcherVersion: string;
  startedAtMs: number;
  finishedAtMs: number | null;
  outcome: "starting" | "ready" | "attached" | "failed";
  error: string | null;
  stages: StartupStage[];
  desktop: { version: string; build: string; installRoot: string } | null;
}

export interface RendererIntegrationStatus {
  state: "installing" | "installed" | "unavailable";
  error: string | null;
  failures: number;
  lastError: string | null;
  lastFailedAt: number | null;
  lastInstalledAt: number | null;
  updatedAt: number;
}

export interface ControllerStatus {
  pid: number;
  startedAt: number;
  renderer: RendererIntegrationStatus;
}

export interface LogFileEntry {
  name: string;
  size: number;
  modifiedAt: number;
}

async function readBoundedJson(filePath: string): Promise<unknown> {
  try {
    const metadata = await stat(filePath);
    if (!metadata.isFile() || metadata.size > MAX_DIAGNOSTIC_FILE_BYTES) return null;
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

const OUTCOMES = new Set(["starting", "ready", "attached", "failed"]);
const RENDERER_STATES = new Set(["installing", "installed", "unavailable"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStartupRecord(value: unknown): StartupRecord | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string" ||
    typeof value.pid !== "number" ||
    typeof value.startedAtMs !== "number" ||
    (typeof value.finishedAtMs !== "number" &&
      !(value.outcome === "starting" && value.finishedAtMs === null)) ||
    !OUTCOMES.has(String(value.outcome)) ||
    !Array.isArray(value.stages)
  ) {
    return null;
  }
  const desktop = isRecord(value.desktop) ? value.desktop : null;
  return {
    id: value.id,
    pid: value.pid,
    launcherVersion: typeof value.launcherVersion === "string" ? value.launcherVersion : "",
    startedAtMs: value.startedAtMs,
    finishedAtMs: value.finishedAtMs,
    outcome: value.outcome as StartupRecord["outcome"],
    error: typeof value.error === "string" ? value.error : null,
    stages: value.stages
      .filter(isRecord)
      .filter((stage) => typeof stage.name === "string" && typeof stage.elapsedMs === "number")
      .map((stage) => ({ name: stage.name as string, elapsedMs: stage.elapsedMs as number })),
    desktop:
      desktop &&
      typeof desktop.version === "string" &&
      typeof desktop.build === "string" &&
      typeof desktop.installRoot === "string"
        ? { version: desktop.version, build: desktop.build, installRoot: desktop.installRoot }
        : null,
  };
}

export async function readStartupRecords(filePath: string): Promise<StartupRecord[]> {
  const document = await readBoundedJson(filePath);
  if (!isRecord(document) || document.schemaVersion !== 1 || !Array.isArray(document.records)) {
    return [];
  }
  return document.records
    .map(parseStartupRecord)
    .filter((record): record is StartupRecord => record !== null);
}

export async function readControllerStatus(filePath: string): Promise<ControllerStatus | null> {
  const document = await readBoundedJson(filePath);
  if (!isRecord(document) || document.schemaVersion !== 1 || !isRecord(document.renderer)) {
    return null;
  }
  const renderer = document.renderer;
  if (
    typeof document.pid !== "number" ||
    typeof document.startedAt !== "number" ||
    !RENDERER_STATES.has(String(renderer.state)) ||
    typeof renderer.failures !== "number" ||
    typeof renderer.updatedAt !== "number"
  ) {
    return null;
  }
  return {
    pid: document.pid,
    startedAt: document.startedAt,
    renderer: {
      state: renderer.state as RendererIntegrationStatus["state"],
      error: typeof renderer.error === "string" ? renderer.error : null,
      failures: renderer.failures,
      lastError: typeof renderer.lastError === "string" ? renderer.lastError : null,
      lastFailedAt: typeof renderer.lastFailedAt === "number" ? renderer.lastFailedAt : null,
      lastInstalledAt:
        typeof renderer.lastInstalledAt === "number" ? renderer.lastInstalledAt : null,
      updatedAt: renderer.updatedAt,
    },
  };
}

export function isLogFileName(name: string): boolean {
  return LOG_FILE_PATTERN.test(name);
}

export async function listLogFiles(logsDirectory: string): Promise<LogFileEntry[]> {
  let names: string[];
  try {
    names = await readdir(logsDirectory);
  } catch {
    return [];
  }
  const entries = await Promise.all(
    names.filter(isLogFileName).map(async (name): Promise<LogFileEntry | null> => {
      try {
        const metadata = await stat(path.join(logsDirectory, name));
        return metadata.isFile()
          ? { name, size: metadata.size, modifiedAt: metadata.mtimeMs }
          : null;
      } catch {
        return null;
      }
    }),
  );
  return entries
    .filter((entry): entry is LogFileEntry => entry !== null)
    .sort((left, right) => right.modifiedAt - left.modifiedAt);
}

/** Last `maxBytes` of a log, starting at a line boundary when truncated. */
export async function readLogTail(
  logsDirectory: string,
  name: string,
  maxBytes: number = MAX_LOG_TAIL_BYTES,
): Promise<string | null> {
  if (!isLogFileName(name)) return null;
  const limit = Math.max(1, Math.min(maxBytes, MAX_LOG_TAIL_BYTES));
  let handle;
  try {
    handle = await open(path.join(logsDirectory, name), "r");
  } catch {
    return null;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) return null;
    const length = Math.min(limit, metadata.size);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, metadata.size - length);
    let text = buffer.toString("utf8");
    if (length < metadata.size) {
      const newline = text.indexOf("\n");
      text = newline >= 0 ? text.slice(newline + 1) : text;
    }
    return text;
  } finally {
    await handle.close();
  }
}

export type ConsoleHealthState =
  | "starting"
  | "running"
  | "integration-unavailable"
  | "startup-failed"
  | "desktop-missing"
  | "stopped";

export interface ConsoleSummary {
  state: ConsoleHealthState;
  detail: string | null;
}

export interface SummaryInput {
  running: boolean;
  desktopError: string | null;
  latestStartup: StartupRecord | null;
  launcherAlive?: boolean;
  controller: ControllerStatus | null;
  controllerAlive: boolean;
  now?: number;
}

/** A failure that outlasts this long is reported even before a second attempt. */
export const PERSISTENT_INTEGRATION_FAILURE_MS = 60_000;

/**
 * Whether Renderer integration is failing persistently. The first attempt at
 * startup can fail harmlessly while Codex is still loading: the page script is
 * already registered and runs once the page finishes, and the Controller
 * recovers on its next attempt. Only repeated or lasting failures mean
 * codexhost features are missing.
 */
export function integrationFailing(
  renderer: RendererIntegrationStatus | undefined,
  now: number,
): boolean {
  if (renderer?.state !== "unavailable") return false;
  return renderer.failures >= 2 || now - renderer.updatedAt >= PERSISTENT_INTEGRATION_FAILURE_MS;
}

/**
 * The Controller keeps Desktop running when Renderer installation fails, so a
 * "running" Launcher can still mean codexhost features are missing. That case
 * is reported separately from a clean run.
 */
export function summarize(input: SummaryInput): ConsoleSummary {
  if (input.latestStartup?.outcome === "starting" && input.launcherAlive) {
    return { state: "starting", detail: null };
  }
  if (input.running) {
    const renderer = input.controllerAlive ? input.controller?.renderer : undefined;
    if (renderer && integrationFailing(renderer, input.now ?? Date.now())) {
      return { state: "integration-unavailable", detail: renderer.error };
    }
    return { state: "running", detail: null };
  }
  if (input.desktopError) return { state: "desktop-missing", detail: input.desktopError };
  if (input.latestStartup?.outcome === "failed") {
    return { state: "startup-failed", detail: input.latestStartup.error };
  }
  if (input.latestStartup?.outcome === "starting") {
    return { state: "startup-failed", detail: "Launcher exited before startup completed." };
  }
  return { state: "stopped", detail: null };
}

export function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
