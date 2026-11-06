import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import { nativeConversationDbPath } from "./fork.js";

/** agy's step kinds and statuses as stored in a Conversation DB's `steps` table. */
const USER_INPUT_STEP = 14;
const PLANNER_RESPONSE_STEP = 15;
const DONE_STATUS = 3;

/** How often, and how far apart, a still-settling Conversation DB is read again. */
const SETTLE_ATTEMPTS = 3;
const SETTLE_DELAY_MS = 150;

interface StepRow {
  idx: number;
  step_type: number;
  status: number;
  has_error: number;
}

type Verdict = "recovered" | "notRecovered" | "unsettled";

export interface NativeErrorRecoveryQuery {
  /** agy's native Conversation ID. */
  conversationId: string;
  /** The error text agy put in the Turn's `result.error`. */
  error: string;
  /** The home agy resolves `~/.gemini` against. */
  homedir: string;
}

/**
 * Whether agy's latest Turn of a Conversation hit `error` in one step and then went on to finish
 * with a reply.
 *
 * agy ends a Turn with `status: "ERROR"` whenever any step of that Turn failed, even when the
 * agent retried past the failure (for example a transient TLS or network error on one model
 * request) and completed every later step up to its final reply. The Conversation DB shows the
 * difference: in a recovered Turn the step carrying the error is followed by finished steps that
 * end with a planner response.
 *
 * agy also keeps such an error on the Conversation and repeats it in the result of later Turns.
 * When the latest Turn has no step carrying the error, but an earlier Turn of the Conversation
 * does, the error is a stale repeat; the latest Turn counts as recovered when its own steps
 * finished and end with a planner response. Anything else, including a DB that cannot be read, is
 * treated as not recovered so a real failure is never hidden.
 */
export async function nativeTurnRecoveredFromError(
  query: NativeErrorRecoveryQuery,
): Promise<boolean> {
  const error = query.error.trim();
  if (!query.conversationId || !error) return false;

  let DatabaseSync: typeof DatabaseSyncType;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return false;
  }

  const dbPath = nativeConversationDbPath(query.conversationId, query.homedir);
  const errorBytes = Buffer.from(error, "utf8");
  for (let attempt = 1; ; attempt += 1) {
    let verdict: Verdict;
    try {
      verdict = readVerdict(DatabaseSync, dbPath, errorBytes);
    } catch {
      return false;
    }
    if (verdict !== "unsettled") return verdict === "recovered";
    if (attempt >= SETTLE_ATTEMPTS) return false;
    await new Promise((resolve) => setTimeout(resolve, SETTLE_DELAY_MS));
  }
}

function readVerdict(
  DatabaseSync: typeof DatabaseSyncType,
  dbPath: string,
  errorBytes: Uint8Array,
): Verdict {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const turnStart = db
      .prepare("SELECT MAX(idx) AS idx FROM steps WHERE step_type = ?")
      .get(USER_INPUT_STEP) as { idx: number | null } | undefined;
    if (turnStart?.idx === null || turnStart?.idx === undefined) return "notRecovered";
    const steps = db
      .prepare(
        `SELECT idx, step_type, status,
                (instr(COALESCE(step_payload, X''), ?) > 0
                  OR instr(COALESCE(error_details, X''), ?) > 0) AS has_error
           FROM steps WHERE idx > ? ORDER BY idx ASC`,
      )
      .all(errorBytes, errorBytes, turnStart.idx) as unknown as StepRow[];
    if (steps.some((step) => step.has_error)) return verdictForTurn(steps);
    // The latest Turn never hit the error. agy repeats an error an earlier
    // Turn of this Conversation hit (and may have recovered from) in every
    // later Turn's result, so only an error found earlier is a stale repeat.
    const earlier = db
      .prepare(
        `SELECT 1 AS found FROM steps
          WHERE idx < ?
            AND (instr(COALESCE(step_payload, X''), ?) > 0
              OR instr(COALESCE(error_details, X''), ?) > 0)
          LIMIT 1`,
      )
      .get(turnStart.idx, errorBytes, errorBytes) as { found: number } | undefined;
    if (!earlier) return "notRecovered";
    return verdictForFinishedTurn(steps);
  } finally {
    db.close();
  }
}

function verdictForTurn(steps: StepRow[]): Verdict {
  let errorAt = -1;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (steps[index]?.has_error) {
      errorAt = index;
      break;
    }
  }
  if (errorAt < 0) return "notRecovered";
  return verdictForFinishedTurn(steps.slice(errorAt + 1));
}

/** Whether `steps` all finished and end with a planner response. */
function verdictForFinishedTurn(steps: StepRow[]): Verdict {
  const last = steps.at(-1);
  if (!last) return "notRecovered";
  // agy may still be flushing the last steps when the result arrives.
  if (steps.some((step) => step.status !== DONE_STATUS)) return "unsettled";
  return last.step_type === PLANNER_RESPONSE_STEP ? "recovered" : "notRecovered";
}
