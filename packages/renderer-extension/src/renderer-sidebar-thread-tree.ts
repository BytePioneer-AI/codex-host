import {
  THREAD_RELATION_LIST_MAX_LENGTH,
  hostThreadIdSchema,
  type HostThreadId,
} from "@codexhost/shared-contracts";

import type { RendererModelClient } from "./renderer-model-client.js";
import { RendererMethodUnavailableError } from "./renderer-request-sender.js";
import {
  SIDEBAR_THREAD_HOST_ID_ATTRIBUTE,
  SIDEBAR_THREAD_ID_ATTRIBUTE,
  SIDEBAR_THREAD_ROW_ATTRIBUTE,
  SIDEBAR_THREAD_ROW_SELECTOR,
  threadIdFromSidebarRowElement,
} from "./renderer-sidebar-agent-icons.js";

export const SIDEBAR_THREAD_TREE_ITEM_ATTRIBUTE = "data-codexhost-sidebar-thread-tree";
export const SIDEBAR_THREAD_TREE_TOGGLE_ATTRIBUTE = "data-codexhost-sidebar-thread-toggle";
export const SIDEBAR_THREAD_TREE_MIRROR_ATTRIBUTE = "data-codexhost-sidebar-thread-mirror";
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

export interface SidebarThreadForestMirrorPlan {
  /** Position of the mirrored entry in its own native list. */
  list: number;
  index: number;
  plan: SidebarThreadTreeLayoutPlan;
}

export interface SidebarThreadForestListPlan {
  /**
   * One plan per native entry, or null when the list keeps its native layout.
   * A `mirrored` entry is hidden because it is shown under its parent in another list.
   */
  items: (SidebarThreadTreeLayoutPlan & { mirrored: boolean })[] | null;
  /** Entries of other lists shown in this list, under a parent that lives here. */
  mirrors: SidebarThreadForestMirrorPlan[];
}

/**
 * Lay out all native lists together. Desktop files every Thread in exactly one
 * list, and a new Fork is not pinned, so the Fork of a pinned Thread lands in
 * Recents while its parent stays in Pinned. Such a child, with its own
 * subtree, is mirrored into the list that shows its root ancestor and hidden
 * where Desktop placed it; inside each list `layoutSidebarThreadTree` applies.
 * A parent in the same list wins over one elsewhere. Only a key shown once
 * across all lists can move, and a cross-list cycle keeps its entries in place.
 */
export function planSidebarThreadForest(
  lists: readonly (readonly SidebarThreadTreeEntry[])[],
  collapsed: ReadonlySet<string> = new Set(),
): SidebarThreadForestListPlan[] {
  const counts = new Map<string, number>();
  const first = new Map<string, { list: number; index: number }>();
  const indexByKey = lists.map((entries, list) => {
    const indexes = new Map<string, number>();
    entries.forEach(({ key }, index) => {
      if (key === null) return;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (!first.has(key)) first.set(key, { list, index });
      if (!indexes.has(key)) indexes.set(key, index);
    });
    return indexes;
  });
  const parentOf = (list: number, index: number): { list: number; index: number } | null => {
    const entry = lists[list]?.[index];
    if (!entry || entry.key === null || entry.parentKey === null) return null;
    if (entry.parentKey === entry.key || indexByKey[list]?.get(entry.key) !== index) return null;
    const sameList = indexByKey[list]?.get(entry.parentKey);
    if (sameList !== undefined) return { list, index: sameList };
    if (counts.get(entry.key) !== 1) return null;
    return first.get(entry.parentKey) ?? null;
  };
  const displayList = (list: number, index: number): number => {
    const seen = new Set<string>();
    let at = { list, index };
    for (;;) {
      seen.add(`${at.list}:${at.index}`);
      const parent = parentOf(at.list, at.index);
      if (!parent) return at.list;
      if (seen.has(`${parent.list}:${parent.index}`)) return list;
      at = parent;
    }
  };
  const display = lists.map((entries, list) => entries.map((_, index) => displayList(list, index)));

  return lists.map((entries, list): SidebarThreadForestListPlan => {
    const shown: { list: number; index: number }[] = [];
    entries.forEach((_, index) => {
      if (display[list]?.[index] === list) shown.push({ list, index });
    });
    const kept = shown.length;
    lists.forEach((other, otherList) => {
      if (otherList === list) return;
      other.forEach((_, index) => {
        if (display[otherList]?.[index] === list) shown.push({ list: otherList, index });
      });
    });
    const shownEntries = shown.map(
      (source) => lists[source.list]?.[source.index] ?? { key: null, parentKey: null },
    );
    const plans =
      layoutSidebarThreadTree(shownEntries, collapsed) ??
      (kept < entries.length || shown.length > kept
        ? shownEntries.map((_, order) => ({
            order,
            depth: 0,
            hidden: false,
            childCount: 0,
            collapsed: false,
          }))
        : null);
    if (!plans) return { items: null, mirrors: [] };
    const items = entries.map(() => ({
      order: 0,
      depth: 0,
      hidden: true,
      childCount: 0,
      collapsed: false,
      mirrored: true,
    }));
    const mirrors: SidebarThreadForestMirrorPlan[] = [];
    shown.forEach((source, position) => {
      const plan = plans[position];
      if (!plan) return;
      if (source.list === list) items[source.index] = { ...plan, mirrored: false };
      else mirrors.push({ list: source.list, index: source.index, plan });
    });
    return { items, mirrors };
  });
}

export interface SidebarThreadTreeItem {
  /** The Host Thread shown by this list item, or null for any other entry. */
  thread(): { hostId: string; threadId: HostThreadId } | null;
  apply(layout: SidebarThreadTreeLayout | null): void;
}

export interface SidebarThreadTreeMirror {
  /** Thread key of the mirrored entry; one mirror per key and list. */
  key: string;
  /** The native entry, in another list, that the mirror shows and forwards input to. */
  source: SidebarThreadTreeItem;
  layout: SidebarThreadTreeLayout;
}

export interface SidebarThreadTreeList {
  /** Every direct native list entry, in DOM order, without mirrors. */
  items(): readonly SidebarThreadTreeItem[];
  /** Show exactly these mirrors in this list; mirrors not listed are removed. */
  mirror(mirrors: readonly SidebarThreadTreeMirror[]): void;
}

export interface SidebarThreadTreeDom {
  lists(): readonly SidebarThreadTreeList[];
  /** Report any change that can affect Sidebar rows or the applied layout. */
  observe(onChange: () => void): () => void;
  clear(): void;
}

export interface RendererSidebarThreadTree {
  /**
   * Sidebar Threads still listed under `threadId`, at any depth, in list order.
   * Uses the same Delegation and Fork relations as nesting; a listed row is an
   * unarchived Thread, so archived intermediate parents do not break the chain.
   */
  liveDescendants(hostId: string, threadId: HostThreadId): HostThreadId[];
  refresh(): void;
  dispose(): void;
}

const SIDEBAR_THREAD_TREE_MAX_ANCESTRY = 64;

/** Keys from `liveKeys` whose parent chain reaches `rootKey`, in input order. */
export function sidebarThreadDescendantKeys(
  rootKey: string,
  liveKeys: Iterable<string>,
  parentKeyOf: (key: string) => string | null,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const key of liveKeys) {
    if (key === rootKey || seen.has(key)) continue;
    seen.add(key);
    let parent = parentKeyOf(key);
    for (let depth = 0; parent !== null && depth < SIDEBAR_THREAD_TREE_MAX_ANCESTRY; depth += 1) {
      if (parent === key) break;
      if (parent === rootKey) {
        result.push(key);
        break;
      }
      parent = parentKeyOf(parent);
    }
  }
  return result;
}

interface SavedItemStyle {
  order: string;
  marginInlineStart: string;
  display: string;
}

const SIDEBAR_THREAD_TREE_TOGGLE_SIZE_PX = 14;
const SIDEBAR_THREAD_TREE_TOGGLE_GAP_PX = 4;

/**
 * Inline styles for the expand/collapse toggle. The toggle is taken out of
 * flow and pulled into the row's leading padding, so a parent's icon and title
 * stay aligned with siblings that have no toggle. With no insets set, the
 * absolutely positioned toggle keeps its static position at the start of the
 * title trigger (vertically aligned like the icon), and the negative start
 * margin moves it left of the icon.
 */
export const SIDEBAR_THREAD_TREE_TOGGLE_STYLE = {
  position: "absolute",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: `${SIDEBAR_THREAD_TREE_TOGGLE_SIZE_PX}px`,
  height: `${SIDEBAR_THREAD_TREE_TOGGLE_SIZE_PX}px`,
  marginInlineStart: `-${SIDEBAR_THREAD_TREE_TOGGLE_SIZE_PX + SIDEBAR_THREAD_TREE_TOGGLE_GAP_PX}px`,
  flex: "none",
  cursor: "pointer",
  borderRadius: "3px",
  opacity: "0.75",
} as const satisfies Partial<Record<keyof CSSStyleDeclaration, string>>;

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
  Object.assign(toggle.style, SIDEBAR_THREAD_TREE_TOGGLE_STYLE);
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

function applyItemLayout(
  element: HTMLElement,
  layout: SidebarThreadTreeLayout,
  saved: SavedItemStyle | undefined,
): void {
  setStyle(element, "order", String(layout.order));
  const indent = Math.min(layout.depth, SIDEBAR_THREAD_TREE_MAX_INDENT_DEPTH);
  setStyle(
    element,
    "marginInlineStart",
    indent > 0 ? `${indent * SIDEBAR_THREAD_TREE_INDENT_PX}px` : (saved?.marginInlineStart ?? ""),
  );
  setStyle(element, "display", layout.hidden ? "none" : (saved?.display ?? ""));
}

function applyToggle(
  element: HTMLElement,
  titleTrigger: HTMLElement | null,
  toggle: SidebarThreadTreeToggle | null,
): void {
  const existing = [
    ...element.querySelectorAll<HTMLElement>(`[${SIDEBAR_THREAD_TREE_TOGGLE_ATTRIBUTE}]`),
  ];
  if (!toggle || !titleTrigger) {
    for (const node of existing) node.remove();
    return;
  }
  let node = existing.find((candidate) => candidate.parentElement === titleTrigger);
  for (const stale of existing) if (stale !== node) stale.remove();
  if (!node) {
    node = createToggle(element.ownerDocument);
    titleTrigger.prepend(node);
  }
  toggleHandlers.set(node, toggle.onToggle);
  const expanded = toggle.collapsed ? "false" : "true";
  if (node.getAttribute("aria-expanded") !== expanded) node.setAttribute("aria-expanded", expanded);
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

class BrowserSidebarThreadTreeItem implements SidebarThreadTreeItem {
  constructor(readonly element: HTMLElement) {}

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
    if (!element.hasAttribute(SIDEBAR_THREAD_TREE_ITEM_ATTRIBUTE))
      element.setAttribute(SIDEBAR_THREAD_TREE_ITEM_ATTRIBUTE, "");
    applyItemLayout(element, layout, savedItemStyles.get(element));
    applyToggle(
      element,
      this.#row()?.querySelector<HTMLElement>("[data-thread-title-trigger]") ?? null,
      layout.toggle,
    );
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

/**
 * Attributes a mirror must not carry: they identify the native row to Desktop
 * (selection, keyboard cycling, drag and drop) and to CodexHost bindings.
 */
const MIRROR_STRIPPED_ATTRIBUTES = [
  "id",
  "draggable",
  SIDEBAR_THREAD_ROW_ATTRIBUTE,
  SIDEBAR_THREAD_ID_ATTRIBUTE,
  SIDEBAR_THREAD_HOST_ID_ATTRIBUTE,
  SIDEBAR_THREAD_TREE_ITEM_ATTRIBUTE,
  "data-sidebar-cycle-item",
  "data-pinned-content-tab-drop-key",
  "data-codex-tab-conversation-drop-target",
] as const;
const MIRROR_FORWARDED_EVENTS = [
  "click",
  "dblclick",
  "auxclick",
  "contextmenu",
  "keydown",
] as const;

interface MirrorState {
  source: HTMLElement;
  /** Source markup the mirror was cloned from; a change re-clones it. */
  signature: string;
}

const mirrorStates = new WeakMap<HTMLElement, MirrorState>();

/** Element children that also exist in the source; toggles are mirror-only. */
function mirroredChildren(element: Element): Element[] {
  return [...element.children].filter(
    (child) => !child.hasAttribute(SIDEBAR_THREAD_TREE_TOGGLE_ATTRIBUTE),
  );
}

/** The source node at the same position as `target` inside the mirror. */
function mirrorCounterpart(
  mirror: HTMLElement,
  source: HTMLElement,
  target: EventTarget | null,
): Element | null {
  let node: Element | null =
    target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  const path: number[] = [];
  while (node && node !== mirror) {
    const parent: Element | null = node.parentElement;
    if (!parent) return null;
    path.push(mirroredChildren(parent).indexOf(node));
    node = parent;
  }
  if (node !== mirror) return null;
  let match: Element | undefined = source;
  for (const index of path.reverse()) {
    match = index < 0 ? undefined : mirroredChildren(match).at(index);
    if (!match) return null;
  }
  return match;
}

/**
 * Replay activation input on the hidden native entry so navigation, the
 * context menu, and row actions stay Desktop's own. Pointer-only gestures
 * such as drag and drop and hover cards are not forwarded.
 */
function forwardMirrorEvent(event: Event): void {
  const mirror = event.currentTarget;
  if (!(mirror instanceof HTMLElement)) return;
  if (event instanceof KeyboardEvent && event.key !== "Enter" && event.key !== " ") return;
  const source = mirrorStates.get(mirror)?.source;
  if (!source?.isConnected) return;
  const target =
    mirrorCounterpart(mirror, source, event.target) ??
    source.querySelector(SIDEBAR_THREAD_ROW_SELECTOR) ??
    source;
  const modifiers = {
    bubbles: true,
    cancelable: true,
    composed: true,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
  };
  let forwarded: Event | null = null;
  if (event instanceof KeyboardEvent) {
    forwarded = new KeyboardEvent(event.type, {
      ...modifiers,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      key: event.key,
      code: event.code,
      repeat: event.repeat,
    });
  } else if (event instanceof MouseEvent) {
    forwarded = new MouseEvent(event.type, {
      ...modifiers,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      detail: event.detail,
      screenX: event.screenX,
      screenY: event.screenY,
      clientX: event.clientX,
      clientY: event.clientY,
      button: event.button,
      buttons: event.buttons,
    });
  }
  if (!forwarded) return;
  event.preventDefault();
  event.stopPropagation();
  target.dispatchEvent(forwarded);
}

function createMirror(source: HTMLElement, key: string, signature: string): HTMLElement {
  const mirror = source.cloneNode(true);
  if (!(mirror instanceof HTMLElement))
    throw new Error("Sidebar list item clone is not an element");
  for (const node of mirror.querySelectorAll(`[${SIDEBAR_THREAD_TREE_TOGGLE_ATTRIBUTE}]`)) {
    node.remove();
  }
  for (const element of [mirror, ...mirror.querySelectorAll("*")]) {
    for (const name of MIRROR_STRIPPED_ATTRIBUTES) element.removeAttribute(name);
  }
  mirror.setAttribute(SIDEBAR_THREAD_TREE_MIRROR_ATTRIBUTE, key);
  for (const type of MIRROR_FORWARDED_EVENTS) mirror.addEventListener(type, forwardMirrorEvent);
  mirrorStates.set(mirror, { source, signature });
  return mirror;
}

function sidebarListItem(row: Element): HTMLElement | null {
  const item = row.closest<HTMLElement>('[role="listitem"]');
  return item?.parentElement?.getAttribute("role") === "list" ? item : null;
}

class BrowserSidebarThreadTreeList implements SidebarThreadTreeList {
  constructor(
    private readonly element: HTMLElement,
    private readonly itemFor: (element: HTMLElement) => BrowserSidebarThreadTreeItem,
  ) {}

  items(): readonly SidebarThreadTreeItem[] {
    return [...this.element.children]
      .filter(
        (child): child is HTMLElement =>
          child instanceof HTMLElement && !child.hasAttribute(SIDEBAR_THREAD_TREE_MIRROR_ATTRIBUTE),
      )
      .map((child) => this.itemFor(child));
  }

  mirror(mirrors: readonly SidebarThreadTreeMirror[]): void {
    const existing = new Map<string, HTMLElement>();
    for (const child of [...this.element.children]) {
      const key = child.getAttribute(SIDEBAR_THREAD_TREE_MIRROR_ATTRIBUTE);
      if (key === null || !(child instanceof HTMLElement)) continue;
      if (existing.has(key)) child.remove();
      else existing.set(key, child);
    }
    for (const { key, source, layout } of mirrors) {
      if (!(source instanceof BrowserSidebarThreadTreeItem)) continue;
      let mirror = existing.get(key);
      existing.delete(key);
      const signature = source.element.innerHTML;
      const state = mirror && mirrorStates.get(mirror);
      if (!mirror || state?.source !== source.element || state.signature !== signature) {
        const next = createMirror(source.element, key, signature);
        if (mirror) mirror.replaceWith(next);
        else this.element.append(next);
        mirror = next;
      }
      // The source is hidden by layout; show the mirror with its original display.
      applyItemLayout(mirror, layout, savedItemStyles.get(source.element));
      applyToggle(
        mirror,
        mirror.querySelector<HTMLElement>("[data-thread-title-trigger]"),
        layout.toggle,
      );
    }
    for (const stale of existing.values()) stale.remove();
  }
}

/** Row attributes whose change alters what a mirror must show. */
const MIRRORED_ROW_ATTRIBUTES = new Set([
  "data-app-action-sidebar-thread-active",
  "data-app-action-sidebar-thread-selected",
  "data-app-action-sidebar-thread-title",
]);

class BrowserSidebarThreadTreeDom implements SidebarThreadTreeDom {
  readonly #items = new WeakMap<HTMLElement, BrowserSidebarThreadTreeItem>();
  readonly #lists = new WeakMap<HTMLElement, BrowserSidebarThreadTreeList>();

  constructor(private readonly root: ParentNode & Node) {}

  #item = (element: HTMLElement): BrowserSidebarThreadTreeItem => {
    let item = this.#items.get(element);
    if (!item) this.#items.set(element, (item = new BrowserSidebarThreadTreeItem(element)));
    return item;
  };

  #list(element: HTMLElement): BrowserSidebarThreadTreeList {
    let list = this.#lists.get(element);
    if (!list)
      this.#lists.set(element, (list = new BrowserSidebarThreadTreeList(element, this.#item)));
    return list;
  }

  lists(): readonly SidebarThreadTreeList[] {
    const lists = new Set<HTMLElement>();
    for (const row of this.root.querySelectorAll(SIDEBAR_THREAD_ROW_SELECTOR)) {
      const list = sidebarListItem(row)?.parentElement;
      if (list) lists.add(list);
    }
    // Lists that lost their last thread row must still drop old layout and mirrors.
    for (const item of this.root.querySelectorAll<HTMLElement>(
      `[${SIDEBAR_THREAD_TREE_ITEM_ATTRIBUTE}], [${SIDEBAR_THREAD_TREE_MIRROR_ATTRIBUTE}]`,
    )) {
      if (item.parentElement) lists.add(item.parentElement);
      else clearSidebarThreadTreeItem(item);
    }
    return [...lists].map((list) => this.#list(list));
  }

  observe(onChange: () => void): () => void {
    const marked = `[${SIDEBAR_THREAD_TREE_ITEM_ATTRIBUTE}], [${SIDEBAR_THREAD_TREE_MIRROR_ATTRIBUTE}]`;
    const affectsSidebar = (node: Node | null): boolean => {
      if (!(node instanceof Element)) return false;
      if (node.closest(SIDEBAR_THREAD_ROW_SELECTOR)) return true;
      if (node.closest(marked)) return true;
      if (
        node.matches(SIDEBAR_THREAD_ROW_SELECTOR) ||
        node.querySelector(SIDEBAR_THREAD_ROW_SELECTOR)
      )
        return true;
      return node.getAttribute("role") === "list" && node.querySelector(marked) !== null;
    };
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (
          mutation.type === "attributes" &&
          MIRRORED_ROW_ATTRIBUTES.has(mutation.attributeName ?? "")
        ) {
          // Only rows carry these; a cheap ancestor check keeps busy pages fast.
          if (
            mutation.target instanceof Element &&
            mutation.target.closest(SIDEBAR_THREAD_ROW_SELECTOR)
          ) {
            onChange();
            return;
          }
          continue;
        }
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
        SIDEBAR_THREAD_ROW_ATTRIBUTE,
        SIDEBAR_THREAD_ID_ATTRIBUTE,
        SIDEBAR_THREAD_HOST_ID_ATTRIBUTE,
        ...MIRRORED_ROW_ATTRIBUTES,
        "role",
        "style",
      ],
      childList: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }

  clear(): void {
    for (const mirror of this.root.querySelectorAll(`[${SIDEBAR_THREAD_TREE_MIRROR_ATTRIBUTE}]`)) {
      mirror.remove();
    }
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
  /** Called after each layout pass with every Host that has a listed Thread. */
  onHosts?(hostIds: ReadonlySet<string>): void;
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
    const hostIds = new Set<string>();
    const lists = dom.lists();
    const listItems = lists.map((list) => list.items());
    const entries = listItems.map((items) =>
      items.map((item): SidebarThreadTreeEntry => {
        const thread = item.thread();
        if (!thread) return { key: null, parentKey: null };
        const key = threadKey(thread.hostId, thread.threadId);
        hostIds.add(thread.hostId);
        if (!hostRelations.has(key) && !pending.has(key) && !failed.has(key)) {
          let ids = unresolved.get(thread.hostId);
          if (!ids) unresolved.set(thread.hostId, (ids = new Set()));
          ids.add(thread.threadId);
        }
        return { key, parentKey: parentKeyOf(thread.hostId, key) };
      }),
    );
    const layoutOf = (
      plan: SidebarThreadTreeLayoutPlan,
      key: string | null,
    ): SidebarThreadTreeLayout => ({
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
    });
    const plans = planSidebarThreadForest(entries, collapsed);
    // Lay out native entries first so every mirror clones its settled source.
    listItems.forEach((items, listIndex) => {
      const listPlan = plans[listIndex]?.items ?? null;
      items.forEach((item, index) => {
        const plan = listPlan?.[index];
        item.apply(plan ? layoutOf(plan, entries[listIndex]?.[index]?.key ?? null) : null);
      });
    });
    lists.forEach((list, listIndex) => {
      list.mirror(
        (plans[listIndex]?.mirrors ?? []).flatMap(({ list: from, index, plan }) => {
          const source = listItems[from]?.[index];
          const key = entries[from]?.[index]?.key;
          return source && key ? [{ key, source, layout: layoutOf(plan, key) }] : [];
        }),
      );
    });
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
    options.onHosts?.(hostIds);
  };

  const stopObserving = dom.observe(scheduleScan);
  scan();

  return {
    liveDescendants(hostId, threadId) {
      if (disposed) return [];
      const ids = new Map<string, HostThreadId>();
      for (const list of dom.lists()) {
        for (const item of list.items()) {
          const thread = item.thread();
          if (thread?.hostId === hostId)
            ids.set(threadKey(hostId, thread.threadId), thread.threadId);
        }
      }
      return sidebarThreadDescendantKeys(threadKey(hostId, threadId), ids.keys(), (key) =>
        parentKeyOf(hostId, key),
      ).flatMap((key) => {
        const id = ids.get(key);
        return id ? [id] : [];
      });
    },
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
