/** Browser-local ordering includes roots only; descendants contribute aggregate recency. */
import type { SessionListState } from "@deepseek-ai/dsh-api-session-controller/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import {
  deriveThreadForest,
  sessionMemberIds,
  visibleSessionIds,
  type SessionRowState,
} from "./tree.ts";

export function threadTreeOrderSource(
  list: SessionListState,
  rowState: SessionRowState,
): {
  rootIds: ReadonlySet<SessionId>;
  summaries: SessionListState["byId"];
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
  return { rootIds, summaries };
}
