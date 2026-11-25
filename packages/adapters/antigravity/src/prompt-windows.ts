import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, type BigIntStats } from "node:fs";
import {
  access,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { antigravityHome } from "./usage-statistics.js";

/** Interval during which an ACP `session/prompt` (or steered chain) was in flight. */
export interface AntigravityPromptWindow {
  readonly submittedAtMs: number;
  readonly returnedAtMs: number;
}

const VALID_SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u;
const STORE_VERSION = 1;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 10_000;
const PROCESS_START_TOLERANCE_MS = 5_000;
const WINDOWS_RETRY_DELAYS_MS = [10, 30, 70, 150, 300] as const;
const PROCESS_STARTED_AT_MS = Math.round(performance.timeOrigin);
const pendingWrites = new Map<string, Promise<void>>();

export function promptWindowsDirectory(environment: NodeJS.ProcessEnv): string {
  const dataDir =
    environment.CODEXHOST_DATA_DIR?.trim() || path.join(antigravityHome(environment), ".codexhost");
  return path.resolve(dataDir, "antigravity-prompt-windows");
}

export function promptWindowsPath(sessionId: string, environment: NodeJS.ProcessEnv): string {
  if (!VALID_SESSION_ID.test(sessionId)) throw new Error("Invalid native Session ID");
  return path.join(promptWindowsDirectory(environment), `${sessionId}.json`);
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

function parsePromptWindowsJson(raw: string): AntigravityPromptWindow[] {
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; windows?: unknown } | null;
    if (!parsed || parsed.version !== STORE_VERSION || !Array.isArray(parsed.windows)) return [];
    return mergePromptWindows(
      parsed.windows.filter((entry): entry is AntigravityPromptWindow =>
        isValidWindow(entry, true),
      ),
    );
  } catch {
    return [];
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
  if (cutoff === 0) return [];
  const finite = mergePromptWindows(windows).filter((entry) => isValidWindow(entry, true));
  if (cutoff !== undefined && maxRetainedStepCreatedAtMs !== undefined) {
    return finite.filter((entry) => entry.submittedAtMs <= maxRetainedStepCreatedAtMs);
  }
  return finite;
}

export async function readPromptWindows(
  sessionId: string,
  environment: NodeJS.ProcessEnv,
): Promise<AntigravityPromptWindow[]> {
  if (!VALID_SESSION_ID.test(sessionId)) return [];
  try {
    const raw = await readFile(promptWindowsPath(sessionId, environment), "utf8");
    return parsePromptWindowsJson(raw);
  } catch {
    return [];
  }
}

function enqueueFileWrite(file: string, task: () => Promise<void>): Promise<void> {
  const previous = pendingWrites.get(file);
  const next = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(task);
  const tracked = next.finally(() => {
    if (pendingWrites.get(file) === tracked) pendingWrites.delete(file);
  });
  pendingWrites.set(file, tracked);
  return tracked;
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

function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) === "EPERM";
  }
}

function readLinuxStartTicks(pid: number): { alive: boolean; startTicks: string | null } {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    const end = text.lastIndexOf(")");
    const fields =
      end < 0
        ? []
        : text
            .slice(end + 1)
            .trim()
            .split(/\s+/u);
    if (fields[0] === "Z") return { alive: false, startTicks: null };
    return {
      alive: true,
      startTicks: fields[19] && /^\d+$/u.test(fields[19]) ? fields[19] : null,
    };
  } catch (error) {
    if (errnoCode(error) === "ENOENT" && !isPidAlive(pid)) {
      return { alive: false, startTicks: null };
    }
    return { alive: true, startTicks: null };
  }
}

function currentContenderStart(): string {
  const ticks = process.platform === "linux" ? readLinuxStartTicks(process.pid).startTicks : null;
  return ticks ? `ticks${ticks}` : String(PROCESS_STARTED_AT_MS);
}

function queryProcessStartedAtMs(pid: number): number | null {
  if (pid === process.pid) return PROCESS_STARTED_AT_MS;
  try {
    if (process.platform === "darwin") {
      const result = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, LC_ALL: "C" },
        timeout: 1_000,
      }).trim();
      const startedAt = Date.parse(result);
      return Number.isFinite(startedAt) ? startedAt : null;
    }
    if (process.platform === "win32") {
      const query = [
        "$ErrorActionPreference = 'Stop'",
        `$process = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${pid}'`,
        "if ($null -ne $process -and $null -ne $process.CreationDate) { " +
          "$process.CreationDate.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture) }",
      ].join("; ");
      const result = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", query],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
          timeout: 5_000,
        },
      ).trim();
      const startedAt = Date.parse(result);
      return Number.isFinite(startedAt) ? startedAt : null;
    }
  } catch {
    // Unreadable metadata must not disprove a live process.
  }
  return null;
}

/** Process liveness with PID-reuse disambiguation; never evicts a live process by wall-clock age. */
function contenderIsLive(pid: number, startId?: string): boolean {
  if (!isPidAlive(pid)) return false;
  if (process.platform === "linux") {
    const info = readLinuxStartTicks(pid);
    if (!info.alive) return false;
    const expectedTicks = startId ? /^ticks(\d+)$/u.exec(startId)?.[1] : undefined;
    return !expectedTicks || !info.startTicks || expectedTicks === info.startTicks;
  }
  if (!startId || !/^\d+$/u.test(startId)) return true;
  const expected = Number(startId);
  if (!Number.isSafeInteger(expected)) return true;
  const actualStartedAt = queryProcessStartedAtMs(pid);
  return (
    actualStartedAt === null || Math.abs(actualStartedAt - expected) <= PROCESS_START_TOLERANCE_MS
  );
}

/** Publish a complete lock payload atomically without creating an empty `.lock` on write error. */
async function publishLockFile(lockFile: string, content: string): Promise<void> {
  const temporary = `${lockFile}.publish-${process.pid}-${currentContenderStart()}-${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(content, "utf8");
    } finally {
      await handle.close();
    }
    await link(temporary, lockFile);
  } finally {
    await retryOnWindows(() => rm(temporary, { force: true })).catch(() => undefined);
  }
}

async function removeDeadSiblingLinks(
  lockFile: string,
  snapshot: string,
  pinned: BigIntStats,
): Promise<void> {
  const dir = path.dirname(lockFile);
  const base = path.basename(lockFile);
  const snapshotName = path.basename(snapshot);
  for (const entry of await readdir(dir)) {
    if (entry === base || entry === snapshotName || !entry.startsWith(`${base}.`)) continue;
    const match = /^(?:publish|claim)-(\d+)-(?:(ticks\d+|\d+)-)?/u.exec(
      entry.slice(base.length + 1),
    );
    if (!match) continue;
    const siblingPid = Number(match[1]);
    const siblingStart = match[2];
    const siblingPath = path.join(dir, entry);
    let sibling: BigIntStats;
    try {
      sibling = await lstat(siblingPath, { bigint: true });
    } catch (error) {
      if (errnoCode(error) === "ENOENT" || isWindowsTransientError(error)) continue;
      throw error;
    }
    if (sibling.dev !== pinned.dev || sibling.ino !== pinned.ino) continue;
    // Never unlink a live reclaimer's claim based on age; only dead or reused-PID links are stale.
    if (!contenderIsLive(siblingPid, siblingStart)) {
      await retryOnWindows(() => rm(siblingPath, { force: true })).catch((error) => {
        if (!isWindowsTransientError(error)) throw error;
      });
    }
  }
}

async function tryReclaimStaleLock(lockFile: string): Promise<boolean> {
  let info: Awaited<ReturnType<typeof stat>>;
  let inspected: string;
  try {
    [info, inspected] = await Promise.all([stat(lockFile), readFile(lockFile, "utf8")]);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return true;
    if (isWindowsTransientError(error)) return false;
    throw error;
  }
  let parsedPid: number | undefined;
  let parsedStartId: string | undefined;
  try {
    const parsed = JSON.parse(inspected) as { pid?: unknown; startId?: unknown } | null;
    if (typeof parsed?.pid === "number" && Number.isSafeInteger(parsed.pid) && parsed.pid > 0)
      parsedPid = parsed.pid;
    if (typeof parsed?.startId === "string" && parsed.startId.length > 0)
      parsedStartId = parsed.startId;
  } catch {
    // Ownerless or corrupt lock files are only reclaimed once they age past STALE_LOCK_MS.
  }
  if (parsedPid !== undefined) {
    if (contenderIsLive(parsedPid, parsedStartId)) return false;
  } else if (Date.now() - info.mtimeMs < STALE_LOCK_MS) {
    return false;
  }
  // Pin the inspected inode via a hard link. Because live reclaimers' claims are never evicted,
  // nlink === 2n proves exclusive reclaim ownership of this exact inode.
  const snapshot = `${lockFile}.claim-${process.pid}-${currentContenderStart()}-${randomUUID()}`;
  try {
    await link(lockFile, snapshot);
    try {
      if ((await readFile(snapshot, "utf8")) !== inspected) return false;
      let pinned = await stat(snapshot, { bigint: true });
      if (pinned.nlink > 2n) {
        await removeDeadSiblingLinks(lockFile, snapshot, pinned);
        pinned = await stat(snapshot, { bigint: true });
      }
      if (pinned.nlink !== 2n) return false;
      const current = await stat(lockFile, { bigint: true });
      if (current.dev !== pinned.dev || current.ino !== pinned.ino) return false;
      await rm(lockFile);
      return true;
    } finally {
      await retryOnWindows(() => rm(snapshot, { force: true })).catch(() => undefined);
    }
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT") return true;
    if (code === "EEXIST" || isWindowsTransientError(error)) return false;
    throw error;
  }
}

async function releaseLockFile(lockFile: string, expectedPayload: string): Promise<void> {
  let current: string;
  try {
    current = await retryOnWindows(() => readFile(lockFile, "utf8"));
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return;
    throw error;
  }
  if (current !== expectedPayload) return;
  try {
    await retryOnWindows(() => rm(lockFile));
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return;
    throw error;
  }
}

async function withFileLock<T>(
  file: string,
  work: () => Promise<T>,
  timeoutMs = LOCK_TIMEOUT_MS,
): Promise<T> {
  const lockFile = `${file}.lock`;
  const token = randomUUID();
  const payload = JSON.stringify({
    pid: process.pid,
    startId: currentContenderStart(),
    token,
    createdAtMs: Date.now(),
  });
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await publishLockFile(lockFile, payload);
      break;
    } catch (error) {
      const code = errnoCode(error);
      if (code !== "EEXIST" && !isWindowsTransientError(error)) throw error;
      if (code === "EEXIST" && (await tryReclaimStaleLock(lockFile))) continue;
      if (Date.now() >= deadline) throw new Error("Timed out acquiring prompt windows lock");
      await delay(5 + Math.floor(Math.random() * 20));
    }
  }
  let workError: unknown;
  let hasWorkError = false;
  let result!: T;
  try {
    result = await work();
  } catch (error) {
    workError = error;
    hasWorkError = true;
  }
  try {
    await releaseLockFile(lockFile, payload);
  } catch (releaseError) {
    if (!hasWorkError) throw releaseError;
  }
  if (hasWorkError) throw workError;
  return result;
}

async function readExistingWindowsForWrite(file: string): Promise<AntigravityPromptWindow[]> {
  try {
    return parsePromptWindowsJson(await retryOnWindows(() => readFile(file, "utf8")));
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return [];
    throw error;
  }
}

export async function savePromptWindows(
  sessionId: string,
  windows: readonly AntigravityPromptWindow[],
  environment: NodeJS.ProcessEnv,
  options?: { lockTimeoutMs?: number },
): Promise<void> {
  if (!VALID_SESSION_ID.test(sessionId)) return;
  const finite = mergePromptWindows(windows).filter((entry) => isValidWindow(entry, true));
  if (!finite.length) return;
  const file = promptWindowsPath(sessionId, environment);
  await enqueueFileWrite(file, async () => {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await withFileLock(
      file,
      async () => {
        const existing = await readExistingWindowsForWrite(file);
        const merged = mergePromptWindows(existing, finite);
        if (!merged.length) return;
        const temporary = `${file}.${randomUUID()}.tmp`;
        const payload = JSON.stringify({ version: STORE_VERSION, windows: merged });
        try {
          await writeFile(temporary, payload, { mode: 0o600 });
          await retryOnWindows(() => rename(temporary, file));
        } finally {
          await retryOnWindows(() => rm(temporary, { force: true })).catch(() => undefined);
        }
      },
      options?.lockTimeoutMs,
    );
  });
}

export async function removePromptWindows(
  sessionId: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  if (!VALID_SESSION_ID.test(sessionId)) return;
  const file = promptWindowsPath(sessionId, environment);
  await enqueueFileWrite(file, async () => {
    try {
      await access(file);
    } catch (error) {
      const code = errnoCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") return;
      throw error;
    }
    await withFileLock(file, async () => {
      await retryOnWindows(() => rm(file, { force: true }));
    });
  });
}
