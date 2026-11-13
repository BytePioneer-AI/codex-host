/** Browser-local Thread folds and navigation reveal, shared by all sidebar projections. */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { WorkspaceBrowserProps } from "../contract/slots.ts";
import {
  deriveThreadForest,
  owningGroupKey,
  owningParentFolder,
  type SessionNode,
} from "../tree.ts";
import { PINNED_SECTION_KEY, WORKSPACES_SECTION_KEY } from "../stores.ts";
import { visibleThreadRows } from "../thread-tree.ts";
import { orderedThreadChildren } from "../thread-tree-order.ts";

const EMPTY_EXPANSION: Readonly<Record<string, boolean>> = {};
const ThreadTreeContext = createContext<{
  expansion: Readonly<Record<string, boolean>>;
  rows: (roots: readonly SessionNode[]) => SessionNode[];
  toggle: (id: string, expanded: boolean) => void;
  rootId: (id: SessionId) => SessionId;
  reveal: (id: SessionId) => void;
  selectSidebarRow: (id: SessionId) => void;
  isSidebarSelection: (id: SessionId) => boolean;
}>({
  expansion: EMPTY_EXPANSION,
  rows: (roots) => visibleThreadRows(roots, EMPTY_EXPANSION),
  toggle: () => {},
  rootId: (id) => id,
  reveal: () => {},
  selectSidebarRow: () => {},
  isSidebarSelection: () => false,
});

export function useThreadTreeView() {
  return useContext(ThreadTreeContext);
}

export function ThreadTreeViewProvider({
  browser,
  children,
}: {
  browser: WorkspaceBrowserProps;
  children: ReactNode;
}) {
  const { useSessions, useStore, useWorkspaces, actions } = browser;
  const list = useSessions((state) => state);
  const workspaceState = useWorkspaces((state) => state);
  const expansion = useStore((state) => state.threadExpansion ?? EMPTY_EXPANSION);
  const archivedFilter = useStore((state) => state.archivedFilter ?? "default");
  const manual = useStore((state) => state.orderBy === "manual");
  const orders = useStore((state) => state.sessionOrderByAccount);
  const forest = useMemo(
    () =>
      deriveThreadForest(
        list,
        {
          pinnedSessionIds: workspaceState.pinnedSessionIds,
          archivedSessionIds: workspaceState.archivedSessionIds,
          archivedFilter,
        },
        new Map(),
      ),
    [list, workspaceState, archivedFilter],
  );
  const targets = useMemo(() => {
    const result = new Map<SessionId, { root: SessionNode; ancestors: string[] }>();
    for (const root of forest) {
      const stack: { node: SessionNode; ancestors: string[] }[] = [{ node: root, ancestors: [] }];
      for (let entry = stack.pop(); entry !== undefined; entry = stack.pop()) {
        result.set(entry.node.id, { root, ancestors: entry.ancestors });
        for (const child of entry.node.tree?.children ?? [])
          stack.push({ node: child, ancestors: [...entry.ancestors, entry.node.id] });
      }
    }
    return result;
  }, [forest]);
  // A row selection remains local to this browser until navigation leaves it.
  // Both reveal effects consult it, including when the current row is clicked again.
  const sidebarSelection = useRef<SessionId | undefined>(undefined);
  const isSidebarSelection = useCallback((id: SessionId) => sidebarSelection.current === id, []);
  const selectSidebarRow = useCallback(
    (id: SessionId) => {
      sidebarSelection.current = id;
      actions.setThreadsExpanded(targets.get(id)?.ancestors ?? [], true);
    },
    [actions, targets],
  );
  const reveal = useCallback(
    (id: SessionId) => {
      sidebarSelection.current = undefined;
      const target = targets.get(id);
      if (target === undefined) return;
      actions.setThreadsExpanded(target.ancestors, true);
      if (target.root.pinned) actions.setSectionExpanded(PINNED_SECTION_KEY, true);
      else {
        const group = owningGroupKey(workspaceState.items, target.root.id);
        actions.setGroupExpanded(group, true);
        actions.setSectionExpanded(WORKSPACES_SECTION_KEY, true);
        const workspace = workspaceState.items.find((item) => item.workspaceId === group);
        const sameHost = workspaceState.items.filter(
          (item) => item.remote?.hostId === workspace?.remote?.hostId,
        );
        let path = workspace?.path;
        while (path !== undefined) {
          const parentPath = owningParentFolder(
            path,
            sameHost.map((item) => item.path),
          );
          const ancestor = sameHost.find((item) => item.path === parentPath);
          if (ancestor === undefined) break;
          actions.setGroupExpanded(ancestor.workspaceId, true);
          path = ancestor.path;
        }
      }
    },
    [actions, targets, workspaceState.items],
  );
  const current = Object.values(list.byId).find((row) => (row.retainedBy.mainView ?? 0) > 0)?.id;
  const navigationSeen = useRef("");
  useEffect(() => {
    if (current === undefined) {
      navigationSeen.current = "";
      return;
    }
    const target = targets.get(current);
    if (target === undefined) return;
    const group = owningGroupKey(workspaceState.items, target.root.id);
    const key = JSON.stringify([current, target.ancestors, group]);
    // Live activity and manual folds must not be mistaken for navigation.
    if (navigationSeen.current === key) return;
    navigationSeen.current = key;
    if (!isSidebarSelection(current)) reveal(current);
  }, [current, isSidebarSelection, reveal, targets, workspaceState.items]);
  const value = useMemo(
    () => ({
      expansion,
      rows: (roots: readonly SessionNode[]) =>
        visibleThreadRows(
          roots,
          expansion,
          manual ? (node) => orderedThreadChildren(node, orders, list.byId) : undefined,
        ),
      toggle: (id: string, expanded: boolean) => actions.setThreadsExpanded([id], expanded),
      rootId: (id: SessionId) => targets.get(id)?.root.id ?? id,
      reveal,
      selectSidebarRow,
      isSidebarSelection,
    }),
    [
      actions,
      expansion,
      manual,
      orders,
      list.byId,
      targets,
      reveal,
      selectSidebarRow,
      isSidebarSelection,
    ],
  );
  return <ThreadTreeContext.Provider value={value}>{children}</ThreadTreeContext.Provider>;
}
