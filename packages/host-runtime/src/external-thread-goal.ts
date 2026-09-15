import type { HostGoal, HostGoalOutcome, HostUsage } from "@codexhost/harness-adapter";
import type { JsonObject } from "@codexhost/shared-contracts";

/** Codex app-server `ThreadGoalStatus` values Desktop understands. */
export type ThreadGoalStatus =
  "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";

const THREAD_GOAL_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
]);

/**
 * Host's view of a Harness-owned Goal for one External Thread.
 *
 * The Harness owns whether a Goal exists and how it is evaluated; Host only
 * adds the Desktop-facing status and usage baseline that Codex's `ThreadGoal`
 * carries and the Harness has no native representation for.
 */
export interface ExternalThreadGoal {
  objective: string;
  status: Extract<ThreadGoalStatus, "active" | "paused" | "blocked" | "complete">;
  tokenBudget: number | null;
  createdAtMs: number;
  updatedAtMs: number;
  /** Session-cumulative total tokens when the Goal was set. */
  tokensAtStart: number;
  /** The Harness already dropped the Goal, so Desktop's follow-up clear needs no native call. */
  nativeCleared: boolean;
}

export interface ThreadGoalSetParams {
  threadId: string;
  objective: string | null;
  status: ThreadGoalStatus | null;
  tokenBudget: number | null | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates Codex `thread/goal/set` params without inventing defaults. */
export function parseThreadGoalSetParams(value: unknown): ThreadGoalSetParams {
  if (!isRecord(value) || typeof value.threadId !== "string" || value.threadId.length === 0) {
    throw new Error("thread/goal/set params.threadId must be non-empty text");
  }
  const objective = value.objective ?? null;
  if (objective !== null && typeof objective !== "string") {
    throw new Error("thread/goal/set params.objective must be text or null");
  }
  const status = value.status ?? null;
  if (status !== null && (typeof status !== "string" || !THREAD_GOAL_STATUSES.has(status))) {
    throw new Error("thread/goal/set params.status is not a Goal status");
  }
  const tokenBudget = value.tokenBudget;
  if (
    tokenBudget !== undefined &&
    tokenBudget !== null &&
    (typeof tokenBudget !== "number" || !Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)
  ) {
    throw new Error("thread/goal/set params.tokenBudget must be a positive integer");
  }
  return {
    threadId: value.threadId,
    objective: objective === null ? null : objective.trim() || null,
    status: status as ThreadGoalStatus | null,
    tokenBudget,
  };
}

export function externalThreadGoalFromHarness(
  goal: HostGoal,
  previous: ExternalThreadGoal | null,
  usage: HostUsage | null,
  nowMs: number,
): ExternalThreadGoal {
  const sameGoal = previous !== null && previous.objective === goal.objective;
  return {
    objective: goal.objective,
    status: sameGoal && previous.status === "paused" ? "paused" : "active",
    tokenBudget: sameGoal ? previous.tokenBudget : null,
    createdAtMs: sameGoal ? previous.createdAtMs : goal.setAtMs || nowMs,
    updatedAtMs: nowMs,
    tokensAtStart: sameGoal ? previous.tokensAtStart : (usage?.totalTokens ?? 0),
    nativeCleared: false,
  };
}

/** Codex marks an achieved Goal `complete`; anything the Harness gave up on is `blocked`. */
export function settledGoalStatus(outcome: HostGoalOutcome): ExternalThreadGoal["status"] | null {
  if (outcome === "cleared") return null;
  return outcome === "achieved" ? "complete" : "blocked";
}

/** Projects Host Goal state into the Codex app-server `ThreadGoal` shape. */
export function projectThreadGoal(input: {
  threadId: string;
  goal: ExternalThreadGoal;
  usage: HostUsage | null;
  nowMs: number;
}): JsonObject {
  const { goal } = input;
  const totalTokens = input.usage?.totalTokens ?? goal.tokensAtStart;
  return {
    threadId: input.threadId,
    objective: goal.objective,
    status: goal.status,
    tokenBudget: goal.tokenBudget,
    tokensUsed: Math.max(0, totalTokens - goal.tokensAtStart),
    timeUsedSeconds: Math.max(0, Math.floor((input.nowMs - goal.createdAtMs) / 1000)),
    createdAt: Math.floor(goal.createdAtMs / 1000),
    updatedAt: Math.floor(goal.updatedAtMs / 1000),
  };
}
