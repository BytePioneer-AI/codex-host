/** Hit testing is independent of DOM events and uses the placement dialog's catalog rules. */
import type { SessionListState } from "@deepseek-ai/dsh-api-session-controller/client";
import { threadPlacementCandidates } from "../thread-tree-catalog.ts";

export function threadDropRegion(
  clientY: number,
  rect: { top: number; height: number },
  manual: boolean,
): "before" | "after" | "under" {
  if (!manual || rect.height <= 0) return "under";
  const fraction = (clientY - rect.top) / rect.height;
  return fraction < 0.25 ? "before" : fraction >= 0.75 ? "after" : "under";
}

export function threadDropTargets(
  list: SessionListState,
  sourceId: string,
  archivedIds: readonly string[],
): ReadonlySet<string> {
  return new Set(threadPlacementCandidates(list, sourceId, archivedIds, "").map((row) => row.id));
}

/** A foreign folder changes membership only; only the owning display group can detach lineage. */
export function threadGroupDrop(
  sourceGroup: string,
  targetGroup: string,
  hasDisplayedParent: boolean,
  localWorkspace: boolean,
): "top" | "folder" | null {
  if (sourceGroup === targetGroup) return hasDisplayedParent ? "top" : null;
  return localWorkspace ? "folder" : null;
}
