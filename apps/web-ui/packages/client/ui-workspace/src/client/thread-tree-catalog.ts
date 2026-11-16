/** Catalog-wide display lineage for actions, independent of the current sidebar filter. */
import type {
  SessionListState,
  SessionSummary,
} from "@deepseek-ai/dsh-api-session-controller/client";
import { SessionId } from "@deepseek-ai/dsh-session/types";
import { threadTreeParentOf } from "./tree.ts";

export function sessionDescendantIds(list: SessionListState, id: string): ReadonlySet<string> {
  const children = new Map<string, string[]>();
  for (const summary of Object.values(list.byId)) {
    const parent = threadTreeParentOf(summary, list);
    if (parent === null) continue;
    const siblings = children.get(parent) ?? [];
    siblings.push(summary.id);
    children.set(parent, siblings);
  }
  const seen = new Set([id]);
  const stack = [...(children.get(id) ?? [])];
  for (let child = stack.pop(); child !== undefined; child = stack.pop()) {
    if (seen.has(child)) continue;
    seen.add(child);
    stack.push(...(children.get(child) ?? []));
  }
  seen.delete(id);
  return seen;
}

export function isLocalThreadTreeMember(summary: SessionSummary | undefined): boolean {
  return (
    summary !== undefined &&
    !summary.blank &&
    summary.origin !== "subagent" &&
    !summary.projectionValues?.remoteHost &&
    summary.projectionValues?.threadTreeParent !== undefined
  );
}

/** Native Subagents retain their own confirmation lines, even below display descendants. */
export function runningSubagentsInThreadSubtree(
  list: SessionListState,
  sessionId: string,
): { id: string; label?: string }[] {
  const stack = [sessionId, ...sessionDescendantIds(list, sessionId)];
  const seen = new Set<string>();
  const running = new Map<string, { id: string; label?: string }>();
  for (let parent = stack.pop(); parent !== undefined; parent = stack.pop()) {
    if (seen.has(parent)) continue;
    seen.add(parent);
    const catalog = list.projectionsBySession[SessionId(parent)]?.values.subagentCatalog ?? [];
    for (const child of catalog) {
      if (list.byId[child.id]?.running)
        running.set(child.id, {
          id: child.id,
          ...(child.label === undefined ? {} : { label: child.label }),
        });
      stack.push(child.id);
    }
  }
  return [...running.values()];
}

export function runningThreadSubtree(
  list: SessionListState,
  sessionId: string,
): { id: string; title: string }[] {
  const ids = new Set([sessionId, ...sessionDescendantIds(list, sessionId)]);
  return Object.values(list.byId)
    .filter((row) => ids.has(row.id) && row.running)
    .map((row) => ({ id: row.id, title: row.title?.trim() || row.displayTitle }));
}
