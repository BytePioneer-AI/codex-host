/** Browser-local ordering includes roots only; descendants contribute aggregate recency. */
import type { SessionListState } from "@deepseek-ai/dsh-api-session-controller/client";
import { SessionId } from "@deepseek-ai/dsh-session/types";
import {
  deriveThreadForest,
  sessionMemberIds,
  visibleSessionIds,
  type SessionNode,
  type SessionRowState,
} from "./tree.ts";

export interface ThreadTreeOrder {
  rootIds: ReadonlySet<SessionId>;
  /** The root each visible descendant is shown under. */
  rootOf: ReadonlyMap<SessionId, SessionId>;
  summaries: SessionListState["byId"];
}

export function threadTreeOrderSource(
  list: SessionListState,
  rowState: SessionRowState,
  precomputedForest?: readonly SessionNode[],
): ThreadTreeOrder {
  const roots = precomputedForest ?? deriveThreadForest(list, rowState, new Map());
  // Invisible members retain saved slots without parenting any visible row.
  const visible = new Set(
    visibleSessionIds(list, rowState.archivedSessionIds, rowState.archivedFilter),
  );
  const rootIds = new Set([
    ...roots.map((row) => row.id),
    ...sessionMemberIds(list, rowState.archivedSessionIds).filter((id) => !visible.has(id)),
  ]);
  const rootOf = new Map<SessionId, SessionId>();
  const summaries = { ...list.byId };
  for (const root of roots) {
    for (const id of root.tree?.descendantIds ?? []) rootOf.set(SessionId(id), root.id);
    const summary = summaries[root.id];
    if (summary !== undefined)
      summaries[root.id] = { ...summary, updatedAt: root.tree?.updatedAt ?? root.updatedAt };
  }
  return { rootIds, rootOf, summaries };
}

/**
 * One Workspace's root rows, as the Desktop sidebar tree lists them. A Thread delegated from a
 * root in another Workspace (or in none) brings that root in at the Thread's slot, so the
 * Workspace still shows the tree instead of losing the Thread; each tree is listed once.
 * @param sessionIds - the Workspace's Host membership.
 * @param order - the tree order source of the current Session list.
 * @returns the root members to order, and which of them only entered through a descendant.
 */
export function workspaceTreeMembers(
  sessionIds: readonly SessionId[],
  order: ThreadTreeOrder,
): { memberIds: SessionId[]; linkedRootIds: ReadonlySet<SessionId> } {
  const own = new Set(sessionIds);
  const memberIds: SessionId[] = [];
  const linkedRootIds = new Set<SessionId>();
  for (const id of sessionIds) {
    if (order.summaries[id] === undefined || order.rootIds.has(id)) {
      memberIds.push(id);
      continue;
    }
    const root = order.rootOf.get(id);
    if (root === undefined || own.has(root) || linkedRootIds.has(root)) continue;
    linkedRootIds.add(root);
    memberIds.push(root);
  }
  return { memberIds, linkedRootIds };
}
