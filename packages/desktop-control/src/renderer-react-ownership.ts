type Fiber = Record<string, unknown>;

/** Dispatched on the Renderer global when the bounded fiber walk gives up.
 * Keep the literal inside committedReactAncestors in sync: that function is
 * serialized for Renderer evaluation and cannot reference this module constant.
 */
export const REACT_FIBER_WALK_LIMIT_EVENT = "codexhost:react-fiber-walk-limit";

/** DOM Fiber pointers can retain the alternate tree after a React commit.
 * Read ownership from the published tree, including its actual parent path:
 * bailout/reused children can also retain stale `return` pointers.
 */
export function committedReactAncestors(value: unknown): readonly Fiber[] {
  // Self-contained: Desktop Control serializes this function for Renderer evaluation.
  // Bound traversal work, not valid UI nesting. Existing Thread layouts can
  // exceed 200 ancestors even when their request manager is nearby.
  // Large Desktop sidebars already exceed 20,000 committed fibers.
  const MAX_VISITED_FIBERS = 200_000;
  const fiber = (value: unknown): Fiber | null =>
    typeof value === "object" && value !== null ? (value as Fiber) : null;
  // An empty result alone leaves the Composer on "Loading models…" with no
  // cause. The event name is inlined because this function is serialized.
  const exhausted = (): readonly Fiber[] => {
    const target = globalThis as { dispatchEvent?: (event: Event) => boolean };
    if (typeof target.dispatchEvent === "function" && typeof CustomEvent === "function")
      target.dispatchEvent(
        new CustomEvent("codexhost:react-fiber-walk-limit", {
          detail: { limit: MAX_VISITED_FIBERS },
        }),
      );
    return [];
  };
  const first = fiber(value);
  if (!first) return [];
  const previous: Fiber[] = [];
  const seen = new Set<Fiber>();
  for (let node: Fiber | null = first; node; node = fiber(node.return)) {
    if (seen.has(node)) return [];
    if (seen.size >= MAX_VISITED_FIBERS) return exhausted();
    seen.add(node);
    previous.push(node);
  }
  const rootState = fiber(previous.at(-1)?.stateNode);
  // Older/partial bindings without a published root keep the existing bounded
  // ancestry inspection. Once a root is observable, never fall back to stale state.
  if (!rootState || !("current" in rootState)) return previous;
  const current = fiber(rootState.current);
  if (!current) return [];

  interface Entry {
    node: Fiber;
    parent: Entry | null;
  }
  const stack: Entry[] = [{ node: current, parent: null }];
  const alternate = fiber(first.alternate);
  seen.clear();
  while (stack.length > 0 && seen.size < MAX_VISITED_FIBERS) {
    const entry = stack.pop();
    if (!entry) break;
    if (seen.has(entry.node)) return [];
    seen.add(entry.node);
    if (entry.node === first || entry.node === alternate) {
      const ancestors: Fiber[] = [];
      for (let cursor: Entry | null = entry; cursor; cursor = cursor.parent)
        ancestors.push(cursor.node);
      return ancestors;
    }
    const sibling = entry.parent && fiber(entry.node.sibling);
    if (sibling) stack.push({ node: sibling, parent: entry.parent });
    const child = fiber(entry.node.child);
    if (child) stack.push({ node: child, parent: entry });
  }
  return stack.length > 0 ? exhausted() : [];
}
