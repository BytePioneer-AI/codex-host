import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HarnessError } from "@codexhost/harness-adapter";

export function nativeConversationDbPath(id: string, home = os.homedir()): string {
  return path.join(home, ".gemini", "antigravity-cli", "conversations", `${id}.db`);
}

/** Read native user-input boundaries without creating or repairing a missing store. */
export async function readNativeTurnCount(dbPath: string): Promise<number> {
  await access(dbPath);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT count(*) AS n FROM steps WHERE step_type = 14").get();
    return Number(row?.n ?? 0);
  } finally {
    db.close();
  }
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
