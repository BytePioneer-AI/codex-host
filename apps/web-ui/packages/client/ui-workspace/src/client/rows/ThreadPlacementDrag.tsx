/** One sidebar placement target; native reference payloads remain owned by the row. */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
  type DragEvent,
} from "react";
import { SessionId } from "@deepseek-ai/dsh-session/types";
import { useSidebarTouch } from "./use-sidebar-touch.ts";
import type { WorkspaceBrowserProps } from "../contract/slots.ts";
import { canPlaceThread } from "../thread-tree-catalog.ts";
import { owningGroupKey, reconcileManualOrder } from "../tree.ts";
import { FLAT_SESSION_ORDER_KEY } from "../stores.ts";
import { pinOrderSource } from "../pin-order.ts";
import { threadChildOrder, threadInsertOrder, threadOrderKey } from "../thread-tree-order.ts";
import { useThreadTreeView } from "./ThreadTreeView.tsx";
import {
  THREAD_DWELL_MS,
  threadDropDwell,
  threadDropRegion,
  threadDropTargets,
  threadGroupDrop,
  type ThreadDwell,
} from "./thread-drop.ts";
import css from "./ThreadPlacementDrag.module.css";

const DragContext = createContext<{
  enabled: boolean;
  start: (id: SessionId, row: HTMLElement, clearSort: () => void, endSort: () => void) => void;
  end: () => boolean;
}>({ enabled: false, start: () => undefined, end: () => true });

export function useThreadPlacementDrag() {
  return useContext(DragContext);
}

type ActiveDrag = {
  id: SessionId;
  group: string;
  hasParent: boolean;
  placeable: boolean;
  targets: ReadonlySet<string>;
  clearSort: () => void;
  endSort: () => void;
};
type RowDrop = {
  kind: "before" | "after" | "sibling" | "under";
  id: SessionId;
  parent: SessionId | null;
  account: string;
};
type Drop =
  | RowDrop
  | { kind: "top" }
  | { kind: "folder"; id: Parameters<WorkspaceBrowserProps["moveSessionToWorkspace"]>[1] };
type Hit = { element: HTMLElement; drop: Drop };

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
  const store = browser.useStore((state) => state);
  const manual = store.orderBy === "manual";
  const view = useThreadTreeView();
  const container = useRef<HTMLDivElement>(null);
  const active = useRef<ActiveDrag | null>(null);
  const hover = useRef<Hit | null>(null);
  const dwell = useRef<ThreadDwell | null>(null);
  const dwellTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const expandTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const clearHover = (): void => {
    clearTimeout(dwellTimer.current);
    clearTimeout(expandTimer.current);
    dwellTimer.current = expandTimer.current = undefined;
    const element = hover.current?.element;
    element?.removeAttribute("data-thread-drop");
    element?.removeAttribute("data-thread-drop-label");
    element?.removeAttribute("data-thread-dwell");
    hover.current = null;
    dwell.current = null;
  };
  useEffect(() => {
    const outside = (event: globalThis.DragEvent): void => {
      if (event.target instanceof Node && container.current?.contains(event.target)) return;
      clearHover();
      active.current?.clearSort();
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
          group:
            row.closest<HTMLElement>("[data-sidebar-group]")?.dataset.sidebarGroup ??
            owningGroupKey(workspaces.items, view.rootId(id)),
          hasParent: row.hasAttribute("data-thread-parent"),
          placeable: canPlaceThread(list.byId[id]) && !workspaces.archivedSessionIds.includes(id),
          targets: threadDropTargets(list, id, workspaces.archivedSessionIds),
          clearSort,
          endSort,
        };
      },
      end: () => {
        clearHover();
        active.current = null;
        return true;
      },
    }),
    [phone, workspaces, list, view],
  );

  const hit = (event: DragEvent<HTMLDivElement>): Hit | null => {
    const source = active.current;
    if (!source?.placeable || !(event.target instanceof Element)) return null;
    const row = event.target.closest<HTMLElement>("[data-thread-depth]");
    if (row) {
      const key = row.dataset.rowKey;
      if (!key) return null;
      const id = SessionId(key.slice(key.indexOf(":") + 1));
      if (!source.targets.has(id)) return null;
      const rect = row.getBoundingClientRect();
      dwell.current = threadDropDwell(
        hover.current?.element === row ? dwell.current : null,
        {
          id,
          x: event.clientX,
          y: event.clientY,
          now: performance.now(),
        },
        rect,
      );
      const kind = threadDropRegion(event.clientY, rect, manual, dwell.current, performance.now());
      const parent =
        kind === "under"
          ? id
          : row.dataset.threadParent
            ? SessionId(row.dataset.threadParent)
            : null;
      const group = row.closest<HTMLElement>("[data-sidebar-group]")?.dataset.sidebarGroup;
      return {
        element: row,
        drop: {
          kind,
          id,
          parent,
          account: parent !== null ? threadOrderKey(parent) : group || FLAT_SESSION_ORDER_KEY,
        },
      };
    }
    const group = event.target.closest<HTMLElement>("[data-sidebar-group]");
    const key = group?.dataset.sidebarGroup;
    if (group === null || key === undefined) return null;
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

  const show = (target: Hit): void => {
    const drop = target.drop;
    target.element.dataset.threadDrop = drop.kind;
    target.element.dataset.threadDropLabel = browser.t(
      drop.kind === "under"
        ? "threadTree.dropUnder"
        : drop.kind === "top"
          ? "threadTree.dropTop"
          : drop.kind === "folder"
            ? "threadTree.dropFolder"
            : "threadTree.dropSibling",
      {
        name:
          "id" in drop ? list.byId[SessionId(drop.id)]?.title || browser.t("session.untitled") : "",
      },
    );
  };

  const over = (event: DragEvent<HTMLDivElement>): void => {
    const source = active.current;
    if (!source) return;
    const previousDwell = dwell.current;
    const target = hit(event);
    source.clearSort();
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = target === null ? "none" : "move";
    if (target === null) {
      clearHover();
      return;
    }
    if (hover.current?.element !== target.element) {
      const nextDwell = "parent" in target.drop ? dwell.current : null;
      clearHover();
      dwell.current = nextDwell;
      if ("parent" in target.drop && target.element.getAttribute("aria-expanded") === "false") {
        const id = target.drop.id;
        expandTimer.current = setTimeout(() => view.toggle(id, true), 600);
      }
    }
    hover.current = target;
    show(target);
    if (dwell.current !== previousDwell) {
      clearTimeout(dwellTimer.current);
      target.element.removeAttribute("data-thread-dwell");
      if (dwell.current !== null && "parent" in target.drop) {
        target.element.dataset.threadDwell = "true";
        // Restart the visual progress when movement resets the dwell anchor.
        target.element.style.animation = "none";
        void target.element.offsetWidth;
        target.element.style.removeProperty("animation");
        const pending = dwell.current;
        const drop = target.drop;
        dwellTimer.current = setTimeout(() => {
          if (
            dwell.current !== pending ||
            hover.current?.element !== target.element ||
            !target.element.isConnected
          )
            return;
          const under: Hit = {
            element: target.element,
            drop: {
              ...drop,
              kind: "under",
              parent: drop.id,
              account: threadOrderKey(drop.id),
            },
          };
          hover.current = under;
          target.element.removeAttribute("data-thread-dwell");
          show(under);
        }, THREAD_DWELL_MS);
      }
    }
  };

  const commit = async (source: ActiveDrag, drop: Drop): Promise<void> => {
    if (drop.kind === "folder") {
      await browser.moveSessionToWorkspace(source.id, drop.id);
      return;
    }
    const parent = drop.kind === "top" ? null : drop.parent;
    const sourceParent = list.byId[source.id]?.projectionValues?.threadTreeParent ?? null;
    const rowState = {
      pinnedSessionIds: workspaces.pinnedSessionIds,
      archivedSessionIds: workspaces.archivedSessionIds,
      archivedFilter: store.archivedFilter ?? ("default" as const),
    };
    const orderSource = pinOrderSource(workspaces.items, list, rowState);
    const account = drop.kind === "top" ? source.group || FLAT_SESSION_ORDER_KEY : drop.account;
    const members = orderSource.members[account] ?? [];
    const saved = store.sessionOrderByAccount[account];
    const order = account.startsWith("thread:")
      ? threadChildOrder(members, saved, list.byId)
      : reconcileManualOrder(members, saved, orderSource.summaries, rowState);
    const next = threadInsertOrder(
      order,
      source.id,
      drop.kind === "before" || drop.kind === "after" ? drop.id : undefined,
      drop.kind === "after" ? "after" : "before",
    );
    if (
      (sourceParent !== parent || drop.kind === "top") &&
      !(await browser.placeSession(source.id, parent))
    )
      return;
    if (manual)
      browser.actions.setSessionOrder(
        account,
        next,
        {},
        {
          ...orderSource,
          members: { ...orderSource.members, [account]: next },
        },
      );
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
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = target === null ? "none" : "move";
          source.endSort();
          active.current = null;
          if (target !== null) void commit(source, target.drop);
        }}
      >
        {children}
      </div>
    </DragContext.Provider>
  );
}
