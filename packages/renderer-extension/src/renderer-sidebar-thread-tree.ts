import {
  THREAD_RELATION_LIST_MAX_LENGTH,
  hostThreadIdSchema,
  type HostThreadId,
} from "@codexhost/shared-contracts";

import type { RendererModelClient } from "./renderer-model-client.js";
import { RendererMethodUnavailableError } from "./renderer-request-sender.js";
import {
  SIDEBAR_THREAD_HOST_ID_ATTRIBUTE,
  SIDEBAR_THREAD_ROW_SELECTOR,
  threadIdFromSidebarRowElement,
} from "./renderer-sidebar-agent-icons.js";

export const SIDEBAR_THREAD_TREE_ITEM_ATTRIBUTE = "data-codexhost-sidebar-thread-tree";
export const SIDEBAR_THREAD_TREE_TOGGLE_ATTRIBUTE = "data-codexhost-sidebar-thread-toggle";
export const SIDEBAR_THREAD_TREE_INDENT_PX = 14;
const SIDEBAR_THREAD_TREE_MAX_INDENT_DEPTH = 6;
const RELATION_RETRY_DELAYS_MS = [1_000, 3_000, 10_000] as const;
const NATIVE_FORK_READ_CONCURRENCY = 4;

/** One Sidebar list entry: its Thread key and the key of its persisted parent. */
export interface SidebarThreadTreeEntry {
  key: string | null;
  parentKey: string | null;
}

export interface SidebarThreadTreeToggle {
  collapsed: boolean;
  childCount: number;
  onToggle(): void;
}

export interface SidebarThreadTreeLayout {
  /** CSS `order` inside the native list; the DOM itself is never moved. */
  order: number;
  depth: number;
  hidden: boolean;
  toggle: SidebarThreadTreeToggle | null;
}

export type SidebarThreadTreeLayoutPlan = Omit<SidebarThreadTreeLayout, "toggle"> & {
  childCount: number;
  collapsed: boolean;
};

/**
 * Order one native list as a tree. Children follow their parent depth-first,
 * keeping native order among siblings. A parent outside this list, a
 * duplicate key, or a cycle leaves the entry at the top level.
 * @returns One plan per entry, or null when nothing in the list is nested.
 */
export function layoutSidebarThreadTree(
  entries: readonly SidebarThreadTreeEntry[],
  collapsed: ReadonlySet<string> = new Set(),
): SidebarThreadTreeLayoutPlan[] | null {
  const indexByKey = new Map<string, number>();
  entries.forEach(({ key }, index) => {
    if (key !== null && !indexByKey.has(key)) indexByKey.set(key, index);
  });
  const parent: (number | undefined)[] = entries.map(({ key, parentKey }, index) => {
    if (key === null || parentKey === null || indexByKey.get(key) !== index) return undefined;
    const parentIndex = indexByKey.get(parentKey);
    return parentIndex === index ? undefined : parentIndex;
  });
  for (let index = 0; index < parent.length; index += 1) {
    let ancestor = parent[index];
    for (let steps = 0; ancestor !== undefined && steps < parent.length; steps += 1) {
      if (ancestor === index) {
        parent[index] = undefined;
        break;
      }
      ancestor = parent[ancestor];
    }
  }
  if (parent.every((value) => value === undefined)) return null;

  const children = entries.map((): number[] => []);
  parent.forEach((parentIndex, index) => {
    if (parentIndex !== undefined) children[parentIndex]?.push(index);
  });
  const plans: SidebarThreadTreeLayoutPlan[] = entries.map(({ key }, index) => ({
    order: 0,
    depth: 0,
    hidden: false,
    childCount: children[index]?.length ?? 0,
    collapsed: key !== null && (children[index]?.length ?? 0) > 0 && collapsed.has(key),
  }));
  let order = 0;
  const visit = (index: number, depth: number, hidden: boolean): void => {
    const plan = plans[index];
    if (!plan) return;
    plan.order = order;
    order += 1;
    plan.depth = depth;
    plan.hidden = hidden;
    for (const child of children[index] ?? []) visit(child, depth + 1, hidden || plan.collapsed);
  };
  parent.forEach((parentIndex, index) => {
    if (parentIndex === undefined) visit(index, 0, false);
  });
  return plans;
}

export interface SidebarThreadTreeItem {
  /** The Host Thread shown by this list item, or null for any other entry. */
  thread(): { hostId: string; threadId: HostThreadId } | null;
  apply(layout: SidebarThreadTreeLayout | null): void;
}

export interface SidebarThreadTreeList {
  /** Every direct native list entry, in DOM order. */
  items(): readonly SidebarThreadTreeItem[];
}

export interface SidebarThreadTreeDom {
  lists(): readonly SidebarThreadTreeList[];
  /** Report any change that can affect Sidebar rows or the applied layout. */
  observe(onChange: () => void): () => void;
  clear(): void;
}

export interface RendererSidebarThreadTree {
  refresh(): void;
  dispose(): void;
}

interface SavedItemStyle {
  order: string;
  marginInlineStart: string;
  display: string;
}

const savedItemStyles = new WeakMap<HTMLElement, SavedItemStyle>();
const toggleHandlers = new WeakMap<HTMLElement, () => void>();

function chevronIcon(document: Document): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "12");
  svg.setAttribute("height", "12");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M6 4l4 4-4 4");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.5");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

function stopRowEvent(event: Event): void {
  // The toggle sits inside the native row button; keep the row's own click,
  // drag, and context handlers from seeing toggle input.
  event.stopPropagation();
}

function createToggle(document: Document): HTMLElement {
  const toggle = document.createElement("span");
  toggle.setAttribute(SIDEBAR_THREAD_TREE_TOGGLE_ATTRIBUTE, "");
  toggle.setAttribute("role", "button");
  toggle.tabIndex = 0;
  toggle.style.display = "inline-flex";
  toggle.style.alignItems = "center";
  toggle.style.justifyContent = "center";
  toggle.style.width = "14px";
  toggle.style.height = "14px";
  toggle.style.flex = "none";
  toggle.style.cursor = "pointer";
  toggle.style.borderRadius = "3px";
  toggle.style.opacity = "0.75";
  toggle.append(chevronIcon(document));
  for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "dblclick"]) {
    toggle.addEventListener(type, stopRowEvent);
  }
  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    event.preventDefault();
    toggleHandlers.get(toggle)?.();
  });
  toggle.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.stopPropagation();
    event.preventDefault();
    toggleHandlers.get(toggle)?.();
  });
  return toggle;
}

function setStyle(element: HTMLElement, property: keyof SavedItemStyle, value: string): void {
  if (element.style[property] !== value) element.style[property] = value;
}

class BrowserSidebarThreadTreeItem implements SidebarThreadTreeItem {
  constructor(private readonly element: HTMLElement) {}

  #row(): HTMLElement | null {
    const rows = this.element.querySelectorAll<HTMLElement>(SIDEBAR_THREAD_ROW_SELECTOR);
    return rows.length === 1 ? (rows[0] ?? null) : null;
  }

  thread(): { hostId: string; threadId: HostThreadId } | null {
    const row = this.#row();
    const hostId = row?.getAttribute(SIDEBAR_THREAD_HOST_ID_ATTRIBUTE);
    const threadId = hostThreadIdSchema.safeParse(row && threadIdFromSidebarRowElement(row));
    return hostId && threadId.success ? { hostId, threadId: threadId.data } : null;
  }

  apply(layout: SidebarThreadTreeLayout | null): void {
    const element = this.element;
    if (!layout) {
      clearSidebarThreadTreeItem(element);
      return;
    }
    if (!savedItemStyles.has(element)) {
      savedItemStyles.set(element, {
        order: element.style.order,
        marginInlineStart: element.style.marginInlineStart,
        display: element.style.display,
      });
    }
    const saved = savedItemStyles.get(element);
    if (!element.hasAttribute(SIDEBAR_THREAD_TREE_ITEM_ATTRIBUTE))
      element.setAttribute(SIDEBAR_THREAD_TREE_ITEM_ATTRIBUTE, "");
    setStyle(element, "order", String(layout.order));
    const indent = Math.min(layout.depth, SIDEBAR_THREAD_TREE_MAX_INDENT_DEPTH);
    setStyle(
      element,
      "marginInlineStart",
      indent > 0 ? `${indent * SIDEBAR_THREAD_TREE_INDENT_PX}px` : (saved?.marginInlineStart ?? ""),
    );
    setStyle(element, "display", layout.hidden ? "none" : (saved?.display ?? ""));
    this.#applyToggle(layout.toggle);
  }

  #applyToggle(toggle: SidebarThreadTreeToggle | null): void {
    const existing = [
      ...this.element.querySelectorAll<HTMLElement>(`[${SIDEBAR_THREAD_TREE_TOGGLE_ATTRIBUTE}]`),
    ];
    const titleTrigger = this.#row()?.querySelector<HTMLElement>("[data-thread-title-trigger]");
    if (!toggle || !titleTrigger) {
      for (const node of existing) node.remove();
      return;
    }
    let node = existing.find((candidate) => candidate.parentElement === titleTrigger);
    for (const stale of existing) if (stale !== node) stale.remove();
    if (!node) {
      node = createToggle(this.element.ownerDocument);
      titleTrigger.prepend(node);
    }
    toggleHandlers.set(node, toggle.onToggle);
    const expanded = toggle.collapsed ? "false" : "true";
    if (node.getAttribute("aria-expanded") !== expanded)
      node.setAttribute("aria-expanded", expanded);
    const label = `${toggle.collapsed ? "Expand" : "Collapse"} ${toggle.childCount} child ${
      toggle.childCount === 1 ? "thread" : "threads"
    }`;
    if (node.getAttribute("aria-label") !== label) {
      node.setAttribute("aria-label", label);
      node.title = label;
    }
    const svg = node.querySelector<SVGElement>("svg");
    const transform = toggle.collapsed ? "" : "rotate(90deg)";
    if (svg && svg.style.transform !== transform) svg.style.transform = transform;
  }
}

function clearSidebarThreadTreeItem(element: HTMLElement): void {
  for (const node of element.querySelectorAll(`[${SIDEBAR_THREAD_TREE_TOGGLE_ATTRIBUTE}]`)) {
    node.remove();
  }
  const saved = savedItemStyles.get(element);
  if (!element.hasAttribute(SIDEBAR_THREAD_TREE_ITEM_ATTRIBUTE) && !saved) return;
  element.removeAttribute(SIDEBAR_THREAD_TREE_ITEM_ATTRIBUTE);
  setStyle(element, "order", saved?.order ?? "");
  setStyle(element, "marginInlineStart", saved?.marginInlineStart ?? "");
  setStyle(element, "display", saved?.display ?? "");
  savedItemStyles.delete(element);
}

function sidebarListItem(row: Element): HTMLElement | null {
  const item = row.closest<HTMLElement>('[role="listitem"]');
  return item?.parentElement?.getAttribute("role") === "list" ? item : null;
}

class BrowserSidebarThreadTreeDom implements SidebarThreadTreeDom {
  readonly #items = new WeakMap<HTMLElement, BrowserSidebarThreadTreeItem>();

  constructor(private readonly root: ParentNode & Node) {}

  #item(element: HTMLElement): BrowserSidebarThreadTreeItem {
    let item = this.#items.get(element);
    if (!item) this.#items.set(element, (item = new BrowserSidebarThreadTreeItem(element)));
    return item;
  }

  lists(): readonly SidebarThreadTreeList[] {
    const lists = new Set<HTMLElement>();
    for (const row of this.root.querySelectorAll(SIDEBAR_THREAD_ROW_SELECTOR)) {
      const list = sidebarListItem(row)?.parentElement;
      if (list) lists.add(list);
    }
    // Lists that lost their last thread row must still drop old layout.
    for (const item of this.root.querySelectorAll<HTMLElement>(
      `[${SIDEBAR_THREAD_TREE_ITEM_ATTRIBUTE}]`,
    )) {
      if (item.parentElement) lists.add(item.parentElement);
      else clearSidebarThreadTreeItem(item);
    }
    return [...lists].map((list) => ({
      items: () =>
        [...list.children]
          .filter((child): child is HTMLElement => child instanceof HTMLElement)
          .map((child) => this.#item(child)),
    }));
  }

  observe(onChange: () => void): () => void {
    const affectsSidebar = (node: Node | null): boolean => {
      if (!(node instanceof Element)) return false;
      if (node.closest(SIDEBAR_THREAD_ROW_SELECTOR)) return true;
      if (node.closest(`[${SIDEBAR_THREAD_TREE_ITEM_ATTRIBUTE}]`)) return true;
      if (
        node.matches(SIDEBAR_THREAD_ROW_SELECTOR) ||
        node.querySelector(SIDEBAR_THREAD_ROW_SELECTOR)
      )
        return true;
      return (
        node.getAttribute("role") === "list" &&
        node.querySelector(`[${SIDEBAR_THREAD_TREE_ITEM_ATTRIBUTE}]`) !== null
      );
    };
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (
          affectsSidebar(mutation.target) ||
          [...mutation.addedNodes].some(affectsSidebar) ||
          [...mutation.removedNodes].some(affectsSidebar)
        ) {
          onChange();
          return;
        }
      }
    });
    observer.observe(this.root, {
      attributes: true,
      attributeFilter: [
        "data-app-action-sidebar-thread-row",
        "data-app-action-sidebar-thread-id",
        SIDEBAR_THREAD_HOST_ID_ATTRIBUTE,
        "role",
        "style",
      ],
      childList: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }

  clear(): void {
    for (const item of this.root.querySelectorAll<HTMLElement>(
      `[${SIDEBAR_THREAD_TREE_ITEM_ATTRIBUTE}]`,
    )) {
      clearSidebarThreadTreeItem(item);
    }
    for (const node of this.root.querySelectorAll(`[${SIDEBAR_THREAD_TREE_TOGGLE_ATTRIBUTE}]`)) {
      node.remove();
    }
  }
}

/**
 * Nest Sidebar Threads under their Delegation or Fork parent. Layout is CSS on
 * the native list items, re-applied after every React update, so selection,
 * navigation, rename, pin, and archive stay native.
 */
export function installRendererSidebarThreadTree(options: {
  getClient(hostId: string): RendererModelClient | null;
  dom?: SidebarThreadTreeDom;
}): RendererSidebarThreadTree {
  const dom = options.dom ?? new BrowserSidebarThreadTreeDom(document);
  /** Host-persisted relation; `null` parent means none is recorded yet. */
  const hostRelations = new Map<string, { owner: "codex" | "external"; parent: string | null }>();
  /** Native Fork sources never change, so a settled read is kept for the Renderer lifetime. */
  const nativeForks = new Map<string, string | null>();
  const nativeFailed = new Set<string>();
  const pending = new Set<string>();
  const nativePending = new Set<string>();
  const nativeQueue: { hostId: string; threadId: HostThreadId }[] = [];
  const failed = new Set<string>();
  const retryAttempts = new Map<string, number>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const collapsed = new Set<string>();
  let nativeActive = 0;
  let disposed = false;
  let scanScheduled = false;

  const threadKey = (hostId: string, threadId: string): string =>
    JSON.stringify([hostId, threadId]);

  const scheduleScan = (): void => {
    if (disposed || scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(scan);
  };

  const scheduleRetry = (key: string): void => {
    if (disposed || retryTimers.has(key)) return;
    const attempt = retryAttempts.get(key) ?? 0;
    const delay = RELATION_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) return;
    retryAttempts.set(key, attempt + 1);
    retryTimers.set(
      key,
      setTimeout(() => {
        retryTimers.delete(key);
        if (disposed) return;
        failed.delete(key);
        const relation = hostRelations.get(key);
        if (relation?.parent === null) hostRelations.delete(key);
        scheduleScan();
      }, delay),
    );
  };

  const pumpNativeReads = (): void => {
    while (!disposed && nativeActive < NATIVE_FORK_READ_CONCURRENCY) {
      const next = nativeQueue.shift();
      if (!next) return;
      const key = threadKey(next.hostId, next.threadId);
      const read = options.getClient(next.hostId)?.readNativeThreadForkSource;
      if (!read) {
        nativePending.delete(key);
        nativeForks.set(key, null);
        continue;
      }
      nativeActive += 1;
      void Promise.resolve()
        .then(() => read(next.threadId))
        .then(
          (parent) => {
            if (disposed) return;
            nativeForks.set(key, parent);
            if (parent !== null) scheduleScan();
          },
          () => {
            // A failed native read leaves the row at the top level; refresh retries.
            if (!disposed) nativeFailed.add(key);
          },
        )
        .finally(() => {
          nativeActive -= 1;
          nativePending.delete(key);
          pumpNativeReads();
        });
    }
  };

  const requestNativeFork = (hostId: string, threadId: HostThreadId): void => {
    const key = threadKey(hostId, threadId);
    if (nativeForks.has(key) || nativePending.has(key) || nativeFailed.has(key)) return;
    nativePending.add(key);
    nativeQueue.push({ hostId, threadId });
    pumpNativeReads();
  };

  const requestRelations = (
    hostId: string,
    threadIds: HostThreadId[],
    client: RendererModelClient,
  ): void => {
    const list = client.listThreadRelations;
    if (!list) {
      for (const threadId of threadIds) {
        hostRelations.set(threadKey(hostId, threadId), { owner: "codex", parent: null });
        requestNativeFork(hostId, threadId);
      }
      return;
    }
    for (const threadId of threadIds) pending.add(threadKey(hostId, threadId));
    void Promise.resolve()
      .then(() => list({ threadIds }))
      .then(
        ({ threads }) => {
          if (disposed) return;
          let nested = false;
          for (const relation of threads) {
            const key = threadKey(hostId, relation.threadId);
            hostRelations.set(key, {
              owner: relation.owner,
              parent: relation.parent?.threadId ?? null,
            });
            failed.delete(key);
            if (relation.parent) {
              nested = true;
              clearTimeout(retryTimers.get(key));
              retryTimers.delete(key);
              continue;
            }
            // A Delegation can be recorded just after its child row appears.
            scheduleRetry(key);
            if (relation.owner === "codex") requestNativeFork(hostId, relation.threadId);
          }
          if (nested) scheduleScan();
        },
        (error: unknown) => {
          if (disposed) return;
          for (const threadId of threadIds) {
            const key = threadKey(hostId, threadId);
            if (error instanceof RendererMethodUnavailableError) {
              hostRelations.set(key, { owner: "codex", parent: null });
              requestNativeFork(hostId, threadId);
            } else {
              failed.add(key);
              scheduleRetry(key);
            }
          }
        },
      )
      .finally(() => {
        for (const threadId of threadIds) pending.delete(threadKey(hostId, threadId));
      });
  };

  const parentKeyOf = (hostId: string, key: string): string | null => {
    const parent = hostRelations.get(key)?.parent ?? nativeForks.get(key) ?? null;
    return parent === null ? null : threadKey(hostId, parent);
  };

  const scan = (): void => {
    scanScheduled = false;
    if (disposed) return;
    const unresolved = new Map<string, Set<HostThreadId>>();
    for (const list of dom.lists()) {
      const items = list.items();
      const entries = items.map((item): SidebarThreadTreeEntry => {
        const thread = item.thread();
        if (!thread) return { key: null, parentKey: null };
        const key = threadKey(thread.hostId, thread.threadId);
        if (!hostRelations.has(key) && !pending.has(key) && !failed.has(key)) {
          let ids = unresolved.get(thread.hostId);
          if (!ids) unresolved.set(thread.hostId, (ids = new Set()));
          ids.add(thread.threadId);
        }
        return { key, parentKey: parentKeyOf(thread.hostId, key) };
      });
      const plans = layoutSidebarThreadTree(entries, collapsed);
      items.forEach((item, index) => {
        const plan = plans?.[index];
        const key = entries[index]?.key ?? null;
        item.apply(
          plan
            ? {
                order: plan.order,
                depth: plan.depth,
                hidden: plan.hidden,
                toggle:
                  plan.childCount > 0 && key !== null
                    ? {
                        collapsed: plan.collapsed,
                        childCount: plan.childCount,
                        onToggle: () => {
                          if (disposed) return;
                          if (collapsed.has(key)) collapsed.delete(key);
                          else collapsed.add(key);
                          scheduleScan();
                        },
                      }
                    : null,
              }
            : null,
        );
      });
    }
    for (const [hostId, ids] of unresolved) {
      const client = options.getClient(hostId);
      if (!client) continue;
      const threadIds = [...ids];
      for (let index = 0; index < threadIds.length; index += THREAD_RELATION_LIST_MAX_LENGTH) {
        requestRelations(
          hostId,
          threadIds.slice(index, index + THREAD_RELATION_LIST_MAX_LENGTH),
          client,
        );
      }
    }
  };

  const stopObserving = dom.observe(scheduleScan);
  scan();

  return {
    refresh() {
      if (disposed) return;
      failed.clear();
      for (const timer of retryTimers.values()) clearTimeout(timer);
      retryTimers.clear();
      retryAttempts.clear();
      // Recorded parents are immutable; only re-ask Threads without one.
      for (const [key, relation] of hostRelations) {
        if (relation.parent === null) hostRelations.delete(key);
      }
      nativeFailed.clear();
      scheduleScan();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopObserving();
      dom.clear();
      for (const timer of retryTimers.values()) clearTimeout(timer);
      retryTimers.clear();
      retryAttempts.clear();
      hostRelations.clear();
      nativeForks.clear();
      nativeFailed.clear();
      pending.clear();
      nativePending.clear();
      nativeQueue.length = 0;
      failed.clear();
      collapsed.clear();
    },
  };
}
