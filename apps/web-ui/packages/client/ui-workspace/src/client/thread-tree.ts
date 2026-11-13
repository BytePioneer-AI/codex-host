/** Browser-only display lineage; native Subagent lineage never enters this forest. */
export interface ThreadTreeRow {
  id: string;
  updatedAt: number;
  running: boolean;
  pendingInteraction?: string;
  completed: boolean;
}

export interface ThreadTreeInfo<T> {
  depth: number;
  parentId: string | null;
  children: ThreadTreeNode<T>[];
  descendantIds: readonly string[];
  descendantCount: number;
  /** Descendants only: the row keeps its own activity indicators. */
  activity: { running: boolean; pendingInteraction: boolean; completed: boolean };
  updatedAt: number;
}

export type ThreadTreeNode<T> = T & { tree: ThreadTreeInfo<T> };

/**
 * Build from already-visible rows. Missing parents and every member of a cycle
 * become roots. Root order is caller-owned; siblings use their own recency.
 */
export function buildThreadTree<T extends ThreadTreeRow>(
  rows: readonly T[],
  parentOf: (row: T) => string | null | undefined,
): ThreadTreeNode<T>[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const parents = new Map<string, string>();
  for (const row of byId.values()) {
    const parent = parentOf(row);
    if (parent != null && byId.has(parent)) parents.set(row.id, parent);
  }
  const visited = new Set<string>();
  for (const id of byId.keys()) {
    const path: string[] = [];
    const indexes = new Map<string, number>();
    let next: string | undefined = id;
    while (next !== undefined && !visited.has(next)) {
      const cycle = indexes.get(next);
      if (cycle !== undefined) {
        for (const member of path.slice(cycle)) parents.delete(member);
        break;
      }
      indexes.set(next, path.length);
      path.push(next);
      next = parents.get(next);
    }
    for (const member of path) visited.add(member);
  }
  const nodes = new Map<string, ThreadTreeNode<T>>();
  for (const row of byId.values()) {
    nodes.set(row.id, {
      ...row,
      tree: {
        depth: 0,
        parentId: parents.get(row.id) ?? null,
        children: [],
        descendantIds: [],
        descendantCount: 0,
        activity: { running: false, pendingInteraction: false, completed: false },
        updatedAt: row.updatedAt,
      },
    });
  }
  const roots: ThreadTreeNode<T>[] = [];
  for (const node of nodes.values()) {
    const parent = node.tree.parentId === null ? undefined : nodes.get(node.tree.parentId);
    if (parent === undefined) roots.push(node);
    else parent.tree.children.push(node);
  }
  // Iterative traversal also accommodates imported, unusually deep trees.
  const preorder: ThreadTreeNode<T>[] = [];
  const stack = [...roots];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    preorder.push(node);
    const children = [...node.tree.children].sort(
      (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
    );
    node.tree.children = children;
    for (const child of children) {
      child.tree.depth = node.tree.depth + 1;
      stack.push(child);
    }
  }
  for (const node of preorder.reverse()) {
    const ids: string[] = [];
    for (const child of node.tree.children) {
      ids.push(child.id, ...child.tree.descendantIds);
      node.tree.updatedAt = Math.max(node.tree.updatedAt, child.tree.updatedAt);
      node.tree.activity.running ||= child.running || child.tree.activity.running;
      node.tree.activity.pendingInteraction ||=
        child.pendingInteraction !== undefined || child.tree.activity.pendingInteraction;
      node.tree.activity.completed ||= child.completed || child.tree.activity.completed;
    }
    node.tree.descendantIds = ids;
    node.tree.descendantCount = ids.length;
  }
  return roots;
}

/** Preorder rows for one browser's explicit expansion state. */
export function visibleThreadRows<T extends { id: string; tree?: ThreadTreeInfo<T> }>(
  roots: readonly T[],
  expansion: Readonly<Record<string, boolean>>,
): T[] {
  const result: T[] = [];
  const stack = [...roots].reverse();
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    result.push(node);
    if (expansion[node.id]) stack.push(...[...(node.tree?.children ?? [])].reverse());
  }
  return result;
}

/** Raw display ancestors, also usable before the selected row enters a visible forest. */
export function threadAncestors(
  id: string,
  parentOf: (id: string) => string | null | undefined,
): string[] {
  const result: string[] = [];
  const seen = new Set([id]);
  let parent = parentOf(id);
  while (parent != null && !seen.has(parent)) {
    seen.add(parent);
    result.push(parent);
    parent = parentOf(parent);
  }
  return result;
}
