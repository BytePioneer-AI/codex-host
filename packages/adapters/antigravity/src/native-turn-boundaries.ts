import type { HarnessError } from "@codexhost/harness-adapter";

/** Text-recovered history is one native input, not one native boundary per sidecar Turn. */
export async function nativeTurnBoundaryError(
  dbPath: string,
  sidecarTurnCount: number,
): Promise<HarnessError | null> {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const counts = db
        .prepare(
          "SELECT count(*) AS steps, count(CASE WHEN step_type = 14 THEN 1 END) AS turns FROM steps",
        )
        .get() as { steps: number; turns: number };
      // An empty trajectory can still recover the retained sidecar prefix on its next Turn.
      if (counts.steps > 0 && counts.turns !== sidecarTurnCount) {
        return {
          code: "unsupported",
          message:
            "Antigravity cannot fork or roll back precisely: " +
            `native history has ${counts.turns} user_input boundaries but sidecar history has ${sidecarTurnCount} Turns`,
          retryable: false,
        };
      }
    } finally {
      db.close();
    }
  } catch {
    // Unavailable stores follow the existing recovery path; reject only a confirmed mismatch.
  }
  return null;
}
