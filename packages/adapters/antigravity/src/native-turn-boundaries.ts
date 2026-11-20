import { access } from "node:fs/promises";
import type { HarnessError } from "@codexhost/harness-adapter";

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
  const missing = (error as NodeJS.ErrnoException)?.code === "ENOENT";
  return {
    code: missing ? "sessionNotFound" : "nativeFailure",
    message: missing
      ? "Antigravity native conversation database was not found"
      : "Cannot read or derive Antigravity native history",
    retryable: false,
  };
}
