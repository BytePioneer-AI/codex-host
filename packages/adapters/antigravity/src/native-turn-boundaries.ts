import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import type { HarnessError } from "@codexhost/harness-adapter";
import { nativeStepCreatedAtMs } from "./native-request-timing.js";

export function nativeConversationDbPath(id: string, home = os.homedir()): string {
  return path.join(home, ".gemini", "antigravity-cli", "conversations", `${id}.db`);
}

/** Read native user-input boundaries without creating or repairing a missing store. */
export async function readNativeTurnCount(dbPath: string): Promise<number> {
  return withReadSnapshot(dbPath, countInputs);
}

function countInputs(db: DatabaseSync): number {
  return Number(db.prepare("SELECT count(*) AS n FROM steps WHERE step_type = 14").get()?.n ?? 0);
}

function latestInputCreatedAtMs(db: DatabaseSync): number | undefined {
  const columns = db.prepare("PRAGMA table_info(steps)").all() as { name?: unknown }[];
  if (!columns.some((column) => column.name === "metadata")) return undefined;
  const row = db
    .prepare("SELECT metadata FROM steps WHERE step_type = 14 ORDER BY idx DESC LIMIT 1")
    .get();
  return nativeStepCreatedAtMs(row?.metadata);
}

async function withReadSnapshot<T>(dbPath: string, read: (db: DatabaseSync) => T): Promise<T> {
  await access(dbPath);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("BEGIN");
    return read(db);
  } finally {
    db.close();
  }
}

const COMMIT_BUDGET_MS = 250;
const COMMIT_RECHECK_MS = [0, 25, 75, 175, COMMIT_BUDGET_MS];

/** Check fresh WAL snapshots until the current prompt's boundary is visible. */
export async function observeNativeTurnCount(
  dbPath: string,
  before: number | null,
  submittedAtMs: number,
  completedAtMs: number,
  retry: boolean,
  signal: AbortSignal,
): Promise<number | null> {
  const started = performance.now();
  for (const at of retry ? COMMIT_RECHECK_MS : [0]) {
    if (at > 0) {
      const elapsed = performance.now() - started;
      if (elapsed >= COMMIT_BUDGET_MS && at < COMMIT_BUDGET_MS) continue;
      if (elapsed < at)
        await delay(Math.ceil(at - elapsed), undefined, { signal }).catch(() => undefined);
      if (signal.aborted) break;
    }
    try {
      const confirmed = await withReadSnapshot(dbPath, (db) => {
        const count = countInputs(db);
        if (count <= (before ?? 0)) return null;
        // Commit time and prompt text cannot distinguish an earlier late write.
        // Use the native input's creation time, not any reply or tool output.
        const createdAtMs = latestInputCreatedAtMs(db);
        if (createdAtMs !== undefined) {
          return createdAtMs > submittedAtMs && createdAtMs <= completedAtMs ? count : null;
        }
        return before !== null && count === before + 1 ? count : null;
      });
      if (confirmed !== null) return confirmed;
    } catch (error) {
      const { code } = nativeHistoryError(error);
      if (code !== "sessionBusy" && code !== "sessionNotFound") break;
    }
  }
  return null;
}

export function nativeHistoryError(error: unknown): HarnessError {
  const sqlite = error as { code?: string; errcode?: number } | undefined;
  if (sqlite?.code === "ERR_SQLITE_ERROR" && sqlite.errcode !== undefined) {
    const primary = sqlite.errcode & 0xff;
    if (primary === 5 || primary === 6)
      // SQLITE_BUSY / SQLITE_LOCKED, including extended codes
      return {
        code: "sessionBusy",
        message: "Antigravity native history database is locked; retry shortly",
        retryable: true,
      };
  }
  const missing = sqlite?.code === "ENOENT";
  return {
    code: missing ? "sessionNotFound" : "nativeFailure",
    message: missing
      ? "Antigravity native conversation database was not found"
      : "Cannot read or derive Antigravity native history",
    retryable: false,
  };
}
