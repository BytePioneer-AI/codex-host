import { optionalLstat, sessionImportTitle } from "@codexhost/harness-adapter/session-import";

import { nativeConversationSummariesDbPath } from "./fork.js";

/** Normalize an Antigravity native title for `session.title.changed`. */
export function normalizeAntigravityNativeTitle(value: unknown): string | null {
  return sessionImportTitle(value);
}

/**
 * Best-effort read of the persisted native title for one Antigravity conversation.
 * Missing, busy, or unreadable summary databases degrade silently to null.
 */
export async function readNativeSessionTitle(
  nativeSessionId: string,
  home: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (signal?.aborted) return null;
  const file = nativeConversationSummariesDbPath(home);
  const info = await optionalLstat(file).catch(() => null);
  if (signal?.aborted || !info?.isFile()) return null;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    if (signal?.aborted) return null;
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const row = db
        .prepare("SELECT title FROM conversation_summaries WHERE conversation_id = ?")
        .get(nativeSessionId);
      return normalizeAntigravityNativeTitle(row?.title);
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}
