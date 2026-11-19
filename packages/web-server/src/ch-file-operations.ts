import type { ChItem, ChTurn } from "./ch-thread-view.ts";

/** Use original calls for the transcript, never cumulative summary revisions. */
export function conversationItems(turn: ChTurn): ChItem[] {
  if (turn.codexhostFileOperations === undefined) return turn.items;
  const before = new Map<string | null, ChItem[]>();
  for (const operation of turn.codexhostFileOperations) {
    const group = before.get(operation.beforeItemId) ?? [];
    group.push(operation.item);
    before.set(operation.beforeItemId, group);
  }
  const items: ChItem[] = [];
  for (const item of turn.items) {
    if (item.type === "fileChange") continue;
    items.push(...(before.get(item.id) ?? []), item);
    before.delete(item.id);
  }
  // Null anchors follow the last non-file Item. Keep operations even if a
  // legacy Host omitted an anchor instead of silently dropping real work.
  for (const group of before.values()) items.push(...group);
  return items;
}
