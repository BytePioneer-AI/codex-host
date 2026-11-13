/** Browser-local order containers for display-tree roots and children. */
import type { SessionListState } from "@deepseek-ai/dsh-api-session-controller/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import {
  deriveThreadForest,
  orderByRecency,
  reconcileManualOrder,
  sessionMemberIds,
  type SessionNode,
  visibleSessionIds,
  type SessionRowState,
} from "./tree.ts";

export function threadTreeOrderSource(
  list: SessionListState,
  rowState: SessionRowState,
): {
  rootIds: ReadonlySet<SessionId>;
  summaries: SessionListState["byId"];
  childMembers: Record<string, SessionId[]>;
} {
  const roots = deriveThreadForest(list, rowState, new Map());
  // Invisible members retain saved slots without parenting any visible row.
  const visible = new Set(
    visibleSessionIds(list, rowState.archivedSessionIds, rowState.archivedFilter),
  );
  const rootIds = new Set([
    ...roots.map((row) => row.id),
    ...sessionMemberIds(list, rowState.archivedSessionIds).filter((id) => !visible.has(id)),
  ]);
  const summaries = { ...list.byId };
  for (const root of roots) {
    const summary = summaries[root.id];
    if (summary !== undefined)
      summaries[root.id] = { ...summary, updatedAt: root.tree?.updatedAt ?? root.updatedAt };
  }
  const childMembers: Record<string, SessionId[]> = {};
  const stack = [...roots];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    const children = node.tree?.children ?? [];
    if (children.length) childMembers[threadOrderKey(node.id)] = children.map((child) => child.id);
    stack.push(...children);
  }
  return { rootIds, summaries, childMembers };
}

export function threadOrderKey(parentId: string): string {
  return `thread:${parentId}`;
}

/** New children lead saved siblings; departed entries never participate. */
export function threadChildOrder(
  members: readonly SessionId[],
  saved: readonly string[] | undefined,
  summaries: SessionListState["byId"],
): SessionId[] {
  const known = new Set(saved);
  const added = orderByRecency(
    members.filter((id) => !known.has(id)),
    summaries,
  );
  return reconcileManualOrder(members, [...added, ...(saved ?? [])], summaries);
}

/** Order a layer without changing lineage, activity or the caller's forest. */
export function orderedThreadChildren(
  node: SessionNode,
  saved: Readonly<Record<string, readonly string[]>>,
  summaries: SessionListState["byId"],
): SessionNode[] {
  const children = node.tree?.children ?? [];
  const byId = new Map(children.map((child) => [child.id, child]));
  return threadChildOrder(
    children.map((child) => child.id),
    saved[threadOrderKey(node.id)],
    summaries,
  ).flatMap((id) => {
    const child = byId.get(id);
    return child ? [child] : [];
  });
}

/** The source may come from any layer; only destination siblings retain slots. */
export function threadInsertOrder(
  members: readonly SessionId[],
  sourceId: SessionId,
  targetId?: SessionId,
  side: "before" | "after" = "before",
): SessionId[] {
  const next = members.filter((id) => id !== sourceId);
  const index = targetId === undefined ? -1 : next.indexOf(targetId);
  next.splice(index < 0 ? 0 : index + (side === "after" ? 1 : 0), 0, sourceId);
  return next;
}
