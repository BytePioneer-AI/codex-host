import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

import type { DiagnosticLog } from "./diagnostic-log.js";

export interface LogRetentionPolicy {
  maxAgeMs: number;
  maxTotalBytes: number;
  /** Files written this recently may belong to a live Host and are never evicted for size. */
  activeWindowMs: number;
}

export const DEFAULT_LOG_RETENTION: LogRetentionPolicy = {
  maxAgeMs: 14 * 24 * 60 * 60 * 1000,
  maxTotalBytes: 200 * 1024 * 1024,
  activeWindowMs: 60 * 60 * 1000,
};

const LOG_SUBDIRECTORIES = ["threads", "runtime"] as const;
const RETENTION_INITIAL_DELAY_MS = 60_000;
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface LogFile {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface LogRetentionResult {
  deletedFiles: number;
  freedBytes: number;
  remainingBytes: number;
}

/**
 * Deletes expired `.jsonl` files under the log root, then the oldest inactive files until the
 * total fits. Deletion is best-effort: another Host may be deleting or writing concurrently.
 */
export async function collectDiagnosticLogs(
  directory: string,
  now = Date.now(),
  policy: LogRetentionPolicy = DEFAULT_LOG_RETENTION,
): Promise<LogRetentionResult> {
  const files = await listLogFiles(directory);
  let deletedFiles = 0;
  let freedBytes = 0;
  const remove = async (file: LogFile): Promise<boolean> => {
    try {
      await unlink(file.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
    deletedFiles += 1;
    freedBytes += file.size;
    return true;
  };

  const retained: LogFile[] = [];
  for (const file of files) {
    if (now - file.mtimeMs > policy.maxAgeMs && (await remove(file))) continue;
    retained.push(file);
  }
  let remainingBytes = retained.reduce((total, file) => total + file.size, 0);
  for (const file of retained.toSorted((left, right) => left.mtimeMs - right.mtimeMs)) {
    if (remainingBytes <= policy.maxTotalBytes) break;
    if (now - file.mtimeMs < policy.activeWindowMs) continue;
    if (await remove(file)) remainingBytes -= file.size;
  }
  return { deletedFiles, freedBytes, remainingBytes };
}

async function listLogFiles(directory: string): Promise<LogFile[]> {
  const files: LogFile[] = [];
  for (const subdirectory of LOG_SUBDIRECTORIES) {
    const parent = path.join(directory, subdirectory);
    const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const filePath = path.join(parent, entry.name);
      const stats = await stat(filePath).catch(() => null);
      if (stats) files.push({ path: filePath, size: stats.size, mtimeMs: stats.mtimeMs });
    }
  }
  return files;
}

/** Runs retention shortly after startup and daily afterwards without keeping the process alive. */
export function scheduleDiagnosticLogRetention(log: DiagnosticLog): () => void {
  const directory = log.directory;
  if (!directory) return () => undefined;
  let running = false;
  const run = (): void => {
    if (running) return;
    running = true;
    void collectDiagnosticLogs(directory)
      .then((result) => {
        if (result.deletedFiles > 0) log.runtime("info", "log.retention.completed", { ...result });
      })
      .catch(() => undefined)
      .finally(() => {
        running = false;
      });
  };
  const initial = setTimeout(run, RETENTION_INITIAL_DELAY_MS);
  const interval = setInterval(run, RETENTION_INTERVAL_MS);
  initial.unref();
  interval.unref();
  return () => {
    clearTimeout(initial);
    clearInterval(interval);
  };
}
