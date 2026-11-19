import type { ThreadTreeNode } from "@codexhost/shared-contracts";

interface TreeRow<Key, List> {
  key: Key;
  list: List;
  threadId: string;
}

export interface DisplayThread {
  id: string;
  node: ThreadTreeNode;
  children: DisplayThread[];
  activity: { descendants: number; running: number; waiting: number };
}

export type TreePlacement = { kind: "root" | "virtual"; tree: DisplayThread } | { kind: "hidden" };

// Group per sidebar list, at the first mounted member in document order.
// Missing/archived ancestors break the chain; cyclic or overlong ancestry is ignored.
export function planThreadTree<Key, List>(
  snapshot: {
    parents: Readonly<Record<string, string>>;
    nodes: Readonly<Record<string, ThreadTreeNode>>;
  },
  rows: readonly TreeRow<Key, List>[],
): Map<Key, TreePlacement> {
  const { parents, nodes } = snapshot;
  const rootOf = (id: string): string | undefined => {
    const seen = new Set<string>();
    for (let current = id; ;) {
      if (seen.has(current) || seen.size >= 64) return undefined;
      seen.add(current);
      const parent = Object.hasOwn(parents, current) ? parents[current] : undefined;
      if (!parent || !Object.hasOwn(nodes, parent) || nodes[parent]?.archived) return current;
      current = parent;
    }
  };
  const items = new Map<string, DisplayThread>();
  const roots = new Map<string, string>();
  for (const [id, node] of Object.entries(nodes)) {
    if (node.archived) continue;
    const root = rootOf(id);
    if (root === undefined) continue;
    roots.set(id, root);
    items.set(id, { id, node, children: [], activity: { descendants: 0, running: 0, waiting: 0 } });
  }
  for (const [child, parent] of Object.entries(parents)) {
    const thread = items.get(child);
    if (thread) items.get(parent)?.children.push(thread);
  }
  const count = (thread: DisplayThread) => {
    const { activity } = thread;
    for (const child of thread.children) {
      const below = count(child);
      activity.descendants += 1 + below.descendants;
      activity.running += Number(child.node.status === "running") + below.running;
      activity.waiting += Number(child.node.status === "waiting") + below.waiting;
    }
    return activity;
  };
  const placements = new Map<Key, TreePlacement>();
  const seen = new Map<List, Set<string>>();
  for (const { key, list, threadId } of rows) {
    const rootId = roots.get(threadId);
    if (rootId === undefined) continue;
    const tree = items.get(rootId);
    if (!tree?.children.length) continue;
    const placed = seen.get(list) ?? new Set<string>();
    if (placed.has(rootId)) placements.set(key, { kind: "hidden" });
    else {
      if (tree.activity.descendants === 0) count(tree);
      placements.set(key, { kind: threadId === rootId ? "root" : "virtual", tree });
      placed.add(rootId);
      seen.set(list, placed);
    }
  }
  return placements;
}
