import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { antigravityHome } from "./usage-statistics.js";

/** Interval during which an ACP `session/prompt` (or steered chain) was in flight. */
export interface AntigravityPromptWindow {
  readonly submittedAtMs: number;
  readonly returnedAtMs: number;
}

const VALID_SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u;
const WINDOWS_RETRY_DELAYS_MS = [10, 30, 70, 150, 300] as const;

export function promptWindowsDirectory(environment: NodeJS.ProcessEnv): string {
  const dataDir =
    environment.CODEXHOST_DATA_DIR?.trim() || path.join(antigravityHome(environment), ".codexhost");
  return path.resolve(dataDir, "antigravity-prompt-windows");
}

export function promptWindowsPath(sessionId: string, environment: NodeJS.ProcessEnv): string {
  if (!VALID_SESSION_ID.test(sessionId)) throw new Error("Invalid native Session ID");
  return path.join(promptWindowsDirectory(environment), `${sessionId}.jsonl`);
}

function isValidWindow(
  value: unknown,
  requireFiniteEnd: boolean,
): value is AntigravityPromptWindow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { submittedAtMs, returnedAtMs } = value as Record<string, unknown>;
  if (typeof submittedAtMs !== "number" || !Number.isFinite(submittedAtMs) || submittedAtMs < 0)
    return false;
  if (typeof returnedAtMs !== "number") return false;
  if (requireFiniteEnd ? !Number.isFinite(returnedAtMs) : Number.isNaN(returnedAtMs)) return false;
  return returnedAtMs >= submittedAtMs;
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function isWindowsTransientError(error: unknown): boolean {
  if (process.platform !== "win32") return false;
  const code = errnoCode(error);
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

async function retryOnWindows<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const wait = WINDOWS_RETRY_DELAYS_MS[attempt];
      if (wait === undefined || !isWindowsTransientError(error)) throw error;
      await delay(wait);
    }
  }
}

function parsePromptWindowLine(line: string): AntigravityPromptWindow | undefined {
  if (!line.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!isValidWindow(parsed, true)) return undefined;
    return { submittedAtMs: parsed.submittedAtMs, returnedAtMs: parsed.returnedAtMs };
  } catch {
    return undefined;
  }
}

export function isTimestampInPromptWindows(
  timestampMs: number | undefined,
  windows: readonly AntigravityPromptWindow[] | undefined,
): boolean {
  if (timestampMs === undefined || !windows?.length) return false;
  return windows.some(
    (window) => timestampMs >= window.submittedAtMs && timestampMs <= window.returnedAtMs,
  );
}

export function mergePromptWindows(
  ...lists: ReadonlyArray<readonly AntigravityPromptWindow[] | undefined>
): AntigravityPromptWindow[] {
  const valid: AntigravityPromptWindow[] = [];
  for (const list of lists) {
    if (!list) continue;
    for (const entry of list) {
      if (isValidWindow(entry, false)) {
        valid.push({ submittedAtMs: entry.submittedAtMs, returnedAtMs: entry.returnedAtMs });
      }
    }
  }
  valid.sort((left, right) =>
    left.submittedAtMs !== right.submittedAtMs
      ? left.submittedAtMs - right.submittedAtMs
      : left.returnedAtMs - right.returnedAtMs,
  );
  const merged: AntigravityPromptWindow[] = [];
  for (const entry of valid) {
    const previous = merged.at(-1);
    if (
      previous &&
      previous.submittedAtMs === entry.submittedAtMs &&
      previous.returnedAtMs === entry.returnedAtMs
    )
      continue;
    merged.push(entry);
  }
  return merged;
}

export function filterRetainedPromptWindows(
  windows: readonly AntigravityPromptWindow[],
  cutoff: number | undefined,
  maxRetainedStepCreatedAtMs: number | undefined,
): AntigravityPromptWindow[] {
  const finite = mergePromptWindows(windows).filter((entry) => isValidWindow(entry, true));
  if (cutoff === undefined) return finite;
  if (cutoff === 0 || maxRetainedStepCreatedAtMs === undefined) return [];
  return finite.filter((entry) => entry.submittedAtMs <= maxRetainedStepCreatedAtMs);
}

export async function readPromptWindows(
  sessionId: string,
  environment: NodeJS.ProcessEnv,
): Promise<AntigravityPromptWindow[]> {
  if (!VALID_SESSION_ID.test(sessionId)) return [];
  try {
    const raw = await retryOnWindows(() =>
      readFile(promptWindowsPath(sessionId, environment), "utf8"),
    );
    return mergePromptWindows(
      raw
        .split("\n")
        .map(parsePromptWindowLine)
        .filter((entry): entry is AntigravityPromptWindow => entry !== undefined),
    );
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
}

export async function savePromptWindows(
  sessionId: string,
  windows: readonly AntigravityPromptWindow[],
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  if (!VALID_SESSION_ID.test(sessionId)) return;
  const lines = mergePromptWindows(windows)
    .filter((entry) => isValidWindow(entry, true))
    .map((entry) => `${JSON.stringify(entry)}\n`);
  if (!lines.length) return;
  const file = promptWindowsPath(sessionId, environment);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  for (const line of lines) {
    await retryOnWindows(() => appendFile(file, line, { mode: 0o600 }));
  }
}

export async function removePromptWindows(
  sessionId: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  if (!VALID_SESSION_ID.test(sessionId)) return;
  await retryOnWindows(() => rm(promptWindowsPath(sessionId, environment), { force: true }));
}
