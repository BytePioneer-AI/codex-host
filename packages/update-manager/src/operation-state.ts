import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";

import { parseUpdateStatus, type BackgroundUpdateStatus } from "./status.js";

const LOCK_FILE = "active-update-v1.lock";
const STATUS_FILE = "status-v1.json";
const TERMINAL_PHASES = new Set(["succeeded", "failed"]);

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
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith("update-"))
      continue;
    const directory = path.join(stateDirectory, entry.name);
    const statusPath = path.join(directory, STATUS_FILE);
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
): Promise<UpdateOperationLock | null> {
  if (!path.isAbsolute(stateDirectory)) throw new Error("update state directory must be absolute");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const lockPath = path.join(stateDirectory, LOCK_FILE);
  let handle: FileHandle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
  await handle.writeFile(
    `${JSON.stringify({ ownerPid: process.pid, statusPath: null })}\n`,
    "utf8",
  );
  await handle.sync();
  await handle.close();
  let released = false;
  return {
    path: lockPath,
    async setStatusPath(statusPath: string) {
      if (released) throw new Error("update operation lock is released");
      if (!path.isAbsolute(statusPath)) throw new Error("update status path must be absolute");
      await writeFile(
        lockPath,
        `${JSON.stringify({ ownerPid: process.pid, statusPath: path.normalize(statusPath) })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    },
    async release() {
      if (released) return;
      released = true;
      await rm(lockPath, { force: true });
    },
  };
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

export async function recoverUpdateOperationLock(stateDirectory: string): Promise<void> {
  const lockPath = path.join(stateDirectory, LOCK_FILE);
  if (!(await regularFile(lockPath))) return;
  let ownerPid: unknown;
  let statusPath: unknown;
  try {
    const value = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
    ownerPid = value.ownerPid;
    statusPath = value.statusPath;
  } catch {
    return;
  }
  if (typeof statusPath !== "string" || !path.isAbsolute(statusPath)) return;
  try {
    const status = parseUpdateStatus(JSON.parse(await readFile(statusPath, "utf8")));
    if (
      TERMINAL_PHASES.has(status.phase) ||
      typeof ownerPid !== "number" ||
      !processIsAlive(ownerPid)
    ) {
      await rm(lockPath, { force: true });
    }
  } catch {
    // Keep an ambiguous active lock fail-closed.
  }
}
