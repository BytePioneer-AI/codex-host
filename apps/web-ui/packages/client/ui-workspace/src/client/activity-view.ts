/**
 * Pure filtering, prioritization, and unread-ID collection for the sidebar Activity View.
 * Reuses the sidebar display-tree derivation so child-thread activity rolls up consistently.
 */
import type { SessionListState } from "@deepseek-ai/dsh-api-session-controller/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import {
  deriveThreadForest,
  type SessionNode,
  type SessionRowState,
  type SessionStatuses,
} from "./tree.ts";

/** Activity priority bucket: lower number renders higher in the Activity View. */
export type ActivityPriority = 0 | 1 | 2;

/** Derived Activity View projection and attention counts within the active scope. */
export interface ActivityViewProjection {
  /** Active root sessions ordered by priority (pending > running > unread) and recency. */
  readonly rows: readonly SessionNode[];
  /** All unread completed session IDs in scope, including visible thread-tree descendants. */
  readonly unreadSessionIds: readonly SessionId[];
  /** Total sessions (including descendants) with a pending user interaction. */
  readonly pendingCount: number;
  /** Total sessions (including descendants) running or hosting running subagents. */
  readonly runningCount: number;
  /** Total sessions (including descendants) with an unread completion reminder. */
  readonly unreadCount: number;
  /** True when at least one session in scope needs interaction or has an unread completion. */
  readonly hasAttention: boolean;
}

/** Whether a single session row has a pending user interaction. */
function hasOwnPending(node: SessionNode): boolean {
  return node.pendingInteraction !== undefined;
}

/** Whether a single session row is running or has active native subagents. */
function hasOwnRunning(node: SessionNode): boolean {
  return node.running || node.runningSubagentCount > 0;
}

/** Whether a single session row has an unread completion reminder. */
function hasOwnUnread(node: SessionNode): boolean {
  return node.completed;
}

/**
 * Determine the highest activity priority for a root session node (including its descendants).
 * Returns `null` when neither the node nor any visible descendant has active work or unread state.
 */
export function activityPriorityOf(node: SessionNode): ActivityPriority | null {
  if (node.archived || node.blank) return null;
  if (hasOwnPending(node) || (node.tree?.activity.pendingInteraction ?? 0) > 0) return 0;
  if (hasOwnRunning(node) || (node.tree?.activity.running ?? 0) > 0) return 1;
  if (hasOwnUnread(node) || (node.tree?.activity.completed ?? 0) > 0) return 2;
  return null;
}

/**
 * Collect all unread completed session IDs from a set of display-tree roots and their descendants.
 * Excludes archived sessions and deduplicates IDs while preserving traversal order.
 */
export function collectUnreadSessionIds(roots: readonly SessionNode[]): SessionId[] {
  const seen = new Set<SessionId>();
  const result: SessionId[] = [];
  const visit = (node: SessionNode): void => {
    if (!node.archived && !node.blank && hasOwnUnread(node) && !seen.has(node.id)) {
      seen.add(node.id);
      result.push(node.id);
    }
    for (const child of node.tree?.children ?? []) {
      visit(child);
    }
  };
  for (const root of roots) {
    visit(root);
  }
  return result;
}

/**
 * Derive the sorted Activity View rows and attention counters for the current session scope.
 * Archived sessions and blank drafts are always excluded, regardless of the main list's archive filter.
 */
export function deriveActivityView(
  list: SessionListState,
  rowState: SessionRowState,
  statuses: SessionStatuses,
): ActivityViewProjection {
  const activeRowState: SessionRowState = {
    pinnedSessionIds: rowState.pinnedSessionIds,
    archivedSessionIds: rowState.archivedSessionIds,
    archivedFilter: "default",
    ...(rowState.sectionedSessionIds === undefined
      ? {}
      : { sectionedSessionIds: rowState.sectionedSessionIds }),
  };
  const forest = deriveThreadForest(list, activeRowState, statuses);

  const candidates: {
    readonly node: SessionNode;
    readonly priority: ActivityPriority;
    readonly updatedAt: number;
    readonly index: number;
  }[] = [];

  let pendingCount = 0;
  let runningCount = 0;

  for (let index = 0; index < forest.length; index++) {
    const node = forest[index] as SessionNode;
    const priority = activityPriorityOf(node);
    if (priority === null) continue;
    pendingCount += Number(hasOwnPending(node)) + (node.tree?.activity.pendingInteraction ?? 0);
    runningCount += Number(hasOwnRunning(node)) + (node.tree?.activity.running ?? 0);
    candidates.push({
      node,
      priority,
      updatedAt: node.tree?.updatedAt ?? node.updatedAt,
      index,
    });
  }

  candidates.sort(
    (left, right) =>
      left.priority - right.priority ||
      right.updatedAt - left.updatedAt ||
      left.index - right.index,
  );

  const rows = candidates.map((entry) => entry.node);
  const unreadSessionIds = collectUnreadSessionIds(rows);
  const unreadCount = unreadSessionIds.length;

  return {
    rows,
    unreadSessionIds,
    pendingCount,
    runningCount,
    unreadCount,
    hasAttention: pendingCount > 0 || unreadCount > 0,
  };
}
