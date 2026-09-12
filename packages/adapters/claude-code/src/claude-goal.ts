import type { HarnessError, HostGoal, HostGoalOutcome } from "@codexhost/harness-adapter";

/** Claude Code caps `/goal` conditions at this many characters. */
export const CLAUDE_GOAL_OBJECTIVE_LIMIT = 4_000;

export type ClaudeGoalCommandOutcome =
  | { kind: "set"; objective: string }
  | { kind: "cleared"; objective: string }
  | { kind: "noGoal" }
  | { kind: "error"; error: HarnessError };

/** Goal state as derived from native `goal_status` transcript records. */
export interface ClaudeGoalTranscriptState {
  goal: HostGoal | null;
  outcome?: HostGoalOutcome;
  reason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Interprets the text a native `/goal` local command prints. */
export function classifyClaudeGoalCommandOutput(output: string): ClaudeGoalCommandOutcome {
  const text = output.trim();
  if (text.startsWith("Goal set: "))
    return { kind: "set", objective: text.slice("Goal set: ".length) };
  if (text.startsWith("Goal cleared: ")) {
    return { kind: "cleared", objective: text.slice("Goal cleared: ".length) };
  }
  if (text.startsWith("No goal set")) return { kind: "noGoal" };
  if (text.startsWith("Goal condition is limited to ")) {
    return { kind: "error", error: { code: "invalidRequest", message: text, retryable: false } };
  }
  return { kind: "error", error: { code: "unsupported", message: text, retryable: false } };
}

/**
 * Replays Claude's persisted `goal_status` attachments in transcript order.
 *
 * Set and clear write sentinels (`met: false` and `met: true` respectively);
 * the final Stop-hook verdict carries either `met: true` or `failed: true`.
 */
export function deriveClaudeGoalFromTranscript(records: unknown[]): ClaudeGoalTranscriptState {
  let state: ClaudeGoalTranscriptState = { goal: null };
  for (const record of records) {
    if (!isRecord(record) || !isRecord(record.attachment)) continue;
    const status = record.attachment;
    if (status.type !== "goal_status" || typeof status.condition !== "string") continue;
    const reason = typeof status.reason === "string" ? status.reason : undefined;
    if (status.sentinel === true) {
      if (status.met === true) {
        state = state.goal ? { goal: null, outcome: "cleared" } : state;
        continue;
      }
      const setAtMs =
        typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
      state = {
        goal: {
          objective: status.condition,
          setAtMs: Number.isFinite(setAtMs) ? setAtMs : 0,
        },
      };
      continue;
    }
    if (status.met === true) {
      state = { goal: null, outcome: "achieved", ...(reason ? { reason } : {}) };
      continue;
    }
    if (status.failed === true) {
      state = { goal: null, outcome: "unachievable", ...(reason ? { reason } : {}) };
      continue;
    }
  }
  return state;
}
