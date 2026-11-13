/** Hit testing is independent of DOM events and uses the placement dialog's catalog rules. */
import type { SessionListState } from "@deepseek-ai/dsh-api-session-controller/client";
import { threadPlacementCandidates } from "../thread-tree-catalog.ts";

export const THREAD_DWELL_MS = 400;
/** Nesting starts inside the middle half of a row and survives drift until the outer 10% edges. */
const DWELL_ENTER = [0.25, 0.75] as const;
const DWELL_KEEP = [0.1, 0.9] as const;

export type ThreadDwell = { id: string; x: number; y: number; since: number };

/** Staying on one row's middle is the intent; small pointer drift inside the row never restarts it. */
export function threadDropDwell(
  previous: ThreadDwell | null,
  point: { id: string; x: number; y: number; now: number },
  rect: { top: number; height: number },
): ThreadDwell | null {
  if (rect.height <= 0) return null;
  const fraction = (point.y - rect.top) / rect.height;
  const confirmed = previous?.id === point.id && point.now - previous.since >= THREAD_DWELL_MS;
  const [low, high] = confirmed ? DWELL_KEEP : DWELL_ENTER;
  if (fraction < low || fraction > high) return null;
  if (previous?.id === point.id) return previous;
  return { id: point.id, x: point.x, y: point.y, since: point.now };
}

export function threadDropRegion(
  clientY: number,
  rect: { top: number; height: number },
  manual: boolean,
  dwell: ThreadDwell | null = null,
  now = 0,
): "before" | "after" | "under" | "sibling" {
  if (dwell !== null && now - dwell.since >= THREAD_DWELL_MS) return "under";
  if (!manual || rect.height <= 0) return "sibling";
  return clientY < rect.top + rect.height / 2 ? "before" : "after";
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
