import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  readWindowsProcessIdentity,
  type WindowsProcessIdentity,
} from "./windows-process-identity.js";
import { openMutationGuard, type MutationGuard } from "./operation-guard.js";
import { sameWindowsPath } from "./windows-installation.js";
import { parseUpdateStatus, type BackgroundUpdateStatus } from "./status.js";

const LOCK_FILE = "active-update-v1.lock";
const STATUS_FILE = "status-v1.json";
const TERMINAL_PHASES = new Set(["succeeded", "failed"]);

interface OperationRecord {
  ownerPid: number;
  statusPath: string | null;
  operationId?: string;
  ownerStartedAtMicros?: string;
  installationStarted?: boolean;
  remoteUpdate?: boolean;
}

export interface UpdateOperationStateOptions {
  platform?: NodeJS.Platform;
  readProcessIdentity?(pid: number): Promise<WindowsProcessIdentity>;
  processIsAlive?(pid: number): boolean;
  openMutationGuard?(file: string): Promise<MutationGuard>;
}

// The long-lived operation record can change owners. Serialize its short metadata
// mutations so a recovering reader cannot unlink a newly acquired operation.
async function mutateOperation<T>(
  stateDirectory: string,
  options: UpdateOperationStateOptions,
  action: () => Promise<T>,
): Promise<T> {
  if ((options.platform ?? process.platform) !== "win32") return action();
  const file = path.join(stateDirectory, ".active-update-mutation.lock");
  const deadline = performance.now() + 5_000;
  let guard: MutationGuard;
  for (;;) {
    try {
      guard = await (options.openMutationGuard ?? openMutationGuard)(file);
      break;
    } catch (error) {
      if (
        !["EACCES", "EPERM", "EBUSY", "EAGAIN"].includes(
          String((error as NodeJS.ErrnoException).code),
        )
      )
        throw error;
      if (performance.now() >= deadline)
        throw new Error("Update lock metadata is busy or inaccessible", { cause: error });
      await delay(20);
    }
  }
  try {
    return await action();
  } finally {
    await guard.close();
  }
}

// Caller holds the process-lifetime guard. Never publish an empty or truncated
// preparation record: a crash leaves either the prior record or no active record.
async function writeWindowsOperationRecord(
  lockPath: string,
  record: OperationRecord,
): Promise<void> {
  const temporary = path.join(path.dirname(lockPath), `.active-update-record-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, lockPath);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function removeSameLock(lockPath: string, expected: string): Promise<void> {
  if ((await readFile(lockPath, "utf8").catch(() => null)) === expected)
    await rm(lockPath, { force: true });
}

export interface DiscoveredUpdateStatus {
  statusPath: string;
  status: BackgroundUpdateStatus;
}

export interface UpdateOperationLock {
  readonly path: string;
  setStatusPath(statusPath: string): Promise<void>;
  release(): Promise<void>;
}

async function regularFile(filePath: string): Promise<boolean> {
  try {
    const metadata = await lstat(filePath);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function isUpdateOperationActive(stateDirectory: string): Promise<boolean> {
  if (!path.isAbsolute(stateDirectory)) throw new Error("update state directory must be absolute");
  return regularFile(path.join(stateDirectory, LOCK_FILE));
}

// Recover only the operation named by the lock, never an unrelated historical result.
export async function discoverActiveUpdateStatus(
  stateDirectory: string,
): Promise<DiscoveredUpdateStatus | null> {
  if (!path.isAbsolute(stateDirectory)) throw new Error("update state directory must be absolute");
  const lockPath = path.join(stateDirectory, LOCK_FILE);
  if (!(await regularFile(lockPath))) return null;
  try {
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
    if (typeof lock.statusPath !== "string" || !path.isAbsolute(lock.statusPath)) return null;
    if (!(await regularFile(lock.statusPath))) return null;
    const status = parseUpdateStatus(JSON.parse(await readFile(lock.statusPath, "utf8")));
    if (TERMINAL_PHASES.has(status.phase) && lock.installationStarted !== true) return null;
    return { statusPath: lock.statusPath, status };
  } catch {
    return null;
  }
}

export async function discoverLatestUpdateStatus(
  stateDirectory: string,
): Promise<DiscoveredUpdateStatus | null> {
  if (!path.isAbsolute(stateDirectory)) throw new Error("update state directory must be absolute");
  let entries;
  try {
    entries = await readdir(stateDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const candidates: DiscoveredUpdateStatus[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith("update-"))
      continue;
    const statusPath = path.join(stateDirectory, entry.name, STATUS_FILE);
    if (!(await regularFile(statusPath))) continue;
    try {
      candidates.push({
        statusPath,
        status: parseUpdateStatus(JSON.parse(await readFile(statusPath, "utf8"))),
      });
    } catch {
      // Malformed local state is not authoritative for a later operation.
    }
  }
  candidates.sort((left, right) => right.status.updatedAt - left.status.updatedAt);
  return candidates[0] ?? null;
}

export async function cleanupTerminalUpdateState(
  stateDirectory: string,
  options: { now?: number; retentionSeconds?: number } = {},
): Promise<void> {
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  const retentionSeconds = options.retentionSeconds ?? 7 * 24 * 60 * 60;
  let entries;
  try {
    entries = await readdir(stateDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const activePath = await readFile(path.join(stateDirectory, LOCK_FILE), "utf8")
    .then(async (text) => {
      const statusPath = (JSON.parse(text) as OperationRecord).statusPath;
      return typeof statusPath === "string" ? realpath(statusPath) : null;
    })
    .catch(() => null);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith("update-"))
      continue;
    const directory = path.join(stateDirectory, entry.name);
    const statusPath = path.join(directory, STATUS_FILE);
    const canonicalStatus = await realpath(statusPath).catch(() => statusPath);
    if (
      activePath &&
      (process.platform === "win32"
        ? sameWindowsPath(canonicalStatus, activePath)
        : canonicalStatus === activePath)
    )
      continue;
    try {
      const status = parseUpdateStatus(JSON.parse(await readFile(statusPath, "utf8")));
      if (TERMINAL_PHASES.has(status.phase) && now - status.updatedAt > retentionSeconds) {
        await rm(directory, { recursive: true, force: true });
      }
    } catch {
      // Preserve malformed state for bounded diagnostics rather than deleting unknown files.
    }
  }
}

export async function acquireUpdateOperationLock(
  stateDirectory: string,
  options: UpdateOperationStateOptions = {},
): Promise<UpdateOperationLock | null> {
  if (!path.isAbsolute(stateDirectory)) throw new Error("update state directory must be absolute");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  return mutateOperation(stateDirectory, options, async () => {
    const lockPath = path.join(stateDirectory, LOCK_FILE);
    const windows = (options.platform ?? process.platform) === "win32";
    const owner = windows
      ? await (options.readProcessIdentity ?? readWindowsProcessIdentity)(process.pid)
      : null;
    const operationId = randomUUID();
    let record: OperationRecord = {
      ownerPid: process.pid,
      operationId,
      statusPath: null,
      ...(owner ? { ownerStartedAtMicros: owner.startedAtMicros, installationStarted: false } : {}),
    };
    if (windows) {
      const exists = await lstat(lockPath).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      );
      if (exists) return null;
      await writeWindowsOperationRecord(lockPath, record);
    } else {
      let handle: FileHandle;
      try {
        handle = await open(lockPath, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
        throw error;
      }
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        await handle.sync();
      } catch (error) {
        await rm(lockPath, { force: true });
        throw error;
      } finally {
        await handle.close();
      }
    }
    let released = false;
    return {
      path: lockPath,
      async setStatusPath(statusPath: string) {
        return mutateOperation(stateDirectory, options, async () => {
          if (released) throw new Error("update operation lock is released");
          if (!path.isAbsolute(statusPath)) throw new Error("update status path must be absolute");
          const current = JSON.parse(await readFile(lockPath, "utf8")) as OperationRecord;
          if (current.operationId !== operationId || current.ownerPid !== process.pid)
            throw new Error("update operation lock ownership changed");
          const updated = { ...record, statusPath: path.normalize(statusPath) };
          if (windows) await writeWindowsOperationRecord(lockPath, updated);
          else
            await writeFile(lockPath, `${JSON.stringify(updated)}\n`, {
              encoding: "utf8",
              mode: 0o600,
            });
          record = updated;
        });
      },
      async release() {
        if (released) return;
        await mutateOperation(stateDirectory, options, async () => {
          await removeSameLock(lockPath, `${JSON.stringify(record)}\n`);
          released = true;
        });
      },
    };
  });
}

function processIsAlive(processId: number): boolean {
  if (!Number.isSafeInteger(processId) || processId <= 0) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function recoverUpdateOperationLock(
  stateDirectory: string,
  options: UpdateOperationStateOptions = {},
): Promise<void> {
  const lockPath = path.join(stateDirectory, LOCK_FILE);
  if (!(await regularFile(lockPath))) return;
  return mutateOperation(stateDirectory, options, async () => {
    try {
      const original = await readFile(lockPath, "utf8");
      const lock = JSON.parse(original) as OperationRecord;
      if (!Number.isSafeInteger(lock.ownerPid) || lock.ownerPid <= 0) return;
      let alive = (options.processIsAlive ?? processIsAlive)(lock.ownerPid);
      const windows = (options.platform ?? process.platform) === "win32";
      if (windows && alive && lock.ownerStartedAtMicros) {
        const identity = await (options.readProcessIdentity ?? readWindowsProcessIdentity)(
          lock.ownerPid,
        );
        alive = identity.startedAtMicros === lock.ownerStartedAtMicros;
      }
      if (lock.remoteUpdate && !alive) {
        await removeSameLock(lockPath, original);
        return;
      }
      if (windows && alive) return;
      if (typeof lock.statusPath !== "string" || !path.isAbsolute(lock.statusPath)) {
        if (windows && !alive && lock.operationId && lock.installationStarted === false)
          await removeSameLock(lockPath, original);
        return;
      }
      const status = parseUpdateStatus(JSON.parse(await readFile(lock.statusPath, "utf8")));
      if (
        windows &&
        status.phase !== "succeeded" &&
        (lock.installationStarted === true ||
          status.phase === "restarting" ||
          (lock.installationStarted !== false && ["installing", "failed"].includes(status.phase)))
      ) {
        // A dead helper is not proof that replacement left a consistent installation.
        // Keep its lock and external materials; only an unwritten preparation may retry.
        if (lock.installationStarted !== true && (await readFile(lockPath, "utf8")) === original) {
          await writeFile(lockPath, JSON.stringify({ ...lock, installationStarted: true }));
        }
        if (!status.error?.includes("manual repair is required"))
          await writeFile(
            lock.statusPath,
            JSON.stringify({
              ...status,
              phase: "failed",
              error: `${status.error ? `${status.error.slice(0, 250)}. ` : ""}Windows installation may be incomplete; manual repair is required. Operation files are retained for manual repair.`,
            }),
          );
        return;
      }
      if (TERMINAL_PHASES.has(status.phase) || !alive) await removeSameLock(lockPath, original);
    } catch {
      // Unreadable process identity or ambiguous state must not authorize replacement.
    }
  });
}
