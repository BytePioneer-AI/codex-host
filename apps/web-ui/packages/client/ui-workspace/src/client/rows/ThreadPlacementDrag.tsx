/** Sidebar drag placement shares row ordering and preserves native reference payloads. */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
  type DragEvent,
} from "react";
import { useSidebarTouch } from "./use-sidebar-touch.ts";
import { SessionId } from "@deepseek-ai/dsh-session/types";
import type { WorkspaceBrowserProps } from "../contract/slots.ts";
import { canPlaceThread } from "../thread-tree-catalog.ts";
import { owningGroupKey } from "../tree.ts";
import { useThreadTreeView } from "./ThreadTreeView.tsx";
import { threadDropRegion, threadDropTargets, threadGroupDrop } from "./thread-drop.ts";
import css from "./ThreadPlacementDrag.module.css";

const DragContext = createContext<{
  enabled: boolean;
  start: (id: SessionId, row: HTMLElement, clearSort: () => void, endSort: () => void) => void;
  end: () => boolean;
}>({ enabled: false, start: () => undefined, end: () => false });

export function useThreadPlacementDrag() {
  return useContext(DragContext);
}

type ActiveDrag = {
  id: SessionId;
  row: HTMLElement;
  group: string;
  hasParent: boolean;
  placeable: boolean;
  targets: ReadonlySet<string>;
  clearSort: () => void;
  endSort: () => void;
  sorting: boolean;
};

type Drop =
  | { kind: "under"; id: SessionId }
  | { kind: "top" }
  | { kind: "folder"; id: Parameters<WorkspaceBrowserProps["moveSessionToWorkspace"]>[1] };

export function ThreadPlacementDragProvider({
  browser,
  children,
}: {
  browser: WorkspaceBrowserProps;
  children: ReactNode;
}) {
  const phone = useSidebarTouch();
  const list = browser.useSessions((state) => state);
  const workspaces = browser.useWorkspaces((state) => state);
  const manual = browser.useStore((state) => state.orderBy === "manual");
  const view = useThreadTreeView();
  const container = useRef<HTMLDivElement>(null);
  const active = useRef<ActiveDrag | null>(null);
  const hover = useRef<{ element: HTMLElement; drop: Drop } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const clearHover = (): void => {
    clearTimeout(timer.current);
    timer.current = undefined;
    const element = hover.current?.element;
    element?.removeAttribute("data-thread-drop");
    element?.removeAttribute("data-thread-drop-label");
    hover.current = null;
  };
  useEffect(() => {
    const outside = (event: globalThis.DragEvent): void => {
      if (event.target instanceof Node && container.current?.contains(event.target)) return;
      clearHover();
      active.current?.clearSort();
      if (active.current) active.current.sorting = false;
    };
    const cancel = (): void => {
      clearHover();
      active.current?.endSort();
      active.current = null;
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") cancel();
    };
    document.addEventListener("dragover", outside, true);
    document.addEventListener("drop", cancel);
    document.addEventListener("dragend", cancel);
    document.addEventListener("keydown", escape);
    window.addEventListener("blur", cancel);
    return () => {
      document.removeEventListener("dragover", outside, true);
      document.removeEventListener("drop", cancel);
      document.removeEventListener("dragend", cancel);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("blur", cancel);
      clearHover();
    };
  }, []);

  const context = useMemo(
    () => ({
      enabled: !phone,
      start: (id: SessionId, row: HTMLElement, clearSort: () => void, endSort: () => void) => {
        if (phone) return;
        clearHover();
        active.current = {
          id,
          row,
          group: owningGroupKey(workspaces.items, view.rootId(id)),
          hasParent: row.hasAttribute("data-thread-parent"),
          placeable: canPlaceThread(list.byId[id]) && !workspaces.archivedSessionIds.includes(id),
          targets: threadDropTargets(list, id, workspaces.archivedSessionIds),
          clearSort,
          endSort,
          sorting: false,
        };
      },
      end: () => {
        const cancelSort = active.current?.sorting !== true;
        clearHover();
        active.current = null;
        return cancelSort;
      },
    }),
    [phone, workspaces, list, view],
  );

  const hit = (
    event: DragEvent<HTMLDivElement>,
  ): { element: HTMLElement; drop: Drop } | "sort" | null => {
    const source = active.current;
    if (source === null || !(event.target instanceof Element)) return null;
    const row = event.target.closest<HTMLElement>("[data-thread-depth]");
    if (row) {
      const key = row.dataset.rowKey;
      if (!key) return null;
      const id = SessionId(key.slice(key.indexOf(":") + 1));
      const region = threadDropRegion(event.clientY, row.getBoundingClientRect(), manual);
      if (region !== "under") {
        const sameList =
          source.row.closest("[data-sidebar-group]") === row.closest("[data-sidebar-group]");
        return source.row.dataset.threadSortable === "true" &&
          row.dataset.threadSortable === "true" &&
          sameList &&
          source.row.dataset.threadPinned === row.dataset.threadPinned &&
          source.id !== id
          ? "sort"
          : null;
      }
      return source.placeable && source.targets.has(id)
        ? { element: row, drop: { kind: "under", id } }
        : null;
    }
    const group = event.target.closest<HTMLElement>("[data-sidebar-group]");
    const key = group?.dataset.sidebarGroup;
    if (!source.placeable || group === null || key === undefined) return null;
    const workspace = workspaces.items.find((item) => item.workspaceId === key);
    const kind = threadGroupDrop(
      source.group,
      key,
      source.hasParent,
      workspace !== undefined && !workspace.remote,
    );
    if (kind === null) return null;
    const heading = event.target.closest<HTMLElement>("[data-row-key]");
    const element = heading?.dataset.rowKey === `workspace:${key}` ? heading : group;
    if (kind === "folder" && workspace)
      return { element, drop: { kind, id: workspace.workspaceId } };
    return kind === "top" ? { element, drop: { kind } } : null;
  };

  const over = (event: DragEvent<HTMLDivElement>): void => {
    const source = active.current;
    if (!source) return;
    const target = hit(event);
    source.sorting = target === "sort";
    if (target === "sort") {
      clearHover();
      return;
    }
    source.clearSort();
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = target === null ? "none" : "move";
    if (target === null) {
      clearHover();
      return;
    }
    if (hover.current?.element === target.element) return;
    clearHover();
    hover.current = target;
    target.element.dataset.threadDrop = target.drop.kind;
    target.element.dataset.threadDropLabel = browser.t(
      target.drop.kind === "under"
        ? "threadTree.dropUnder"
        : target.drop.kind === "top"
          ? "threadTree.dropTop"
          : "threadTree.dropFolder",
    );
    if (target.drop.kind === "under" && target.element.getAttribute("aria-expanded") === "false") {
      const id = target.drop.id;
      timer.current = setTimeout(() => view.toggle(id, true), 600);
    }
  };

  return (
    <DragContext.Provider value={context}>
      <div
        ref={container}
        className={css.container}
        onDragOverCapture={over}
        onDragLeaveCapture={(event) => {
          if (
            !(event.relatedTarget instanceof Node) ||
            !hover.current?.element.contains(event.relatedTarget)
          )
            clearHover();
        }}
        onDropCapture={(event) => {
          const source = active.current;
          if (!source) return;
          const target = hit(event);
          clearHover();
          if (target === "sort") return;
          event.preventDefault();
          event.stopPropagation();
          source.endSort();
          source.sorting = false;
          active.current = null;
          if (target === null) return;
          const drop = target.drop;
          if (drop.kind === "folder") void browser.moveSessionToWorkspace(source.id, drop.id);
          else void browser.placeSession(source.id, drop.kind === "under" ? drop.id : null);
        }}
      >
        {children}
      </div>
    </DragContext.Provider>
  );
}
