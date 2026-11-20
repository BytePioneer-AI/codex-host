import type {
  DesktopExtensionApiV1,
  DesktopSidebarRow,
  ThreadTreeNode,
  ThreadTreeStatus,
} from "@codexhost/shared-contracts";

/**
 * Corner count on the Agent icon of a Thread whose children appear under it in the Thread tree,
 * colored by the most urgent child state (waiting, then running); activating the icon opens a
 * menu listing each child, most urgent first, with its live status.
 */

const SIDEBAR_AGENT_ICON_ATTRIBUTE = "data-codexhost-sidebar-agent-icon";
const SIDEBAR_AGENT_ICON_SELECTOR = `[${SIDEBAR_AGENT_ICON_ATTRIBUTE}]`;
const EXTENSION_NODE_ATTRIBUTE = "data-cx-extension-node";
const BADGE_ATTRIBUTE = "data-codexhost-delegation-badge";
const POPOVER_ATTRIBUTE = "data-codexhost-delegation-popover";
const CHILD_ATTRIBUTE = "data-codexhost-delegation-child";

const POPOVER_MAX_HEIGHT = 320;
const POPOVER_MAX_WIDTH = 360;
const POPOVER_GAP = 4;
const VIEWPORT_MARGIN = 8;

const PRESS_EVENTS = ["pointerdown", "mousedown", "pointerup", "mouseup"] as const;

const STATE_PRIORITY: Record<ThreadTreeStatus, number> = {
  waiting: 0,
  running: 1,
  unknown: 2,
  idle: 3,
};

const STATE_LABEL: Record<ThreadTreeStatus, string> = {
  waiting: "待回答",
  running: "运行中",
  unknown: "状态未知",
  idle: "无活动",
};

const STATE_GLYPH: Record<ThreadTreeStatus, string> = {
  waiting: "?",
  running: "●",
  unknown: "◌",
  idle: "○",
};

export interface DelegationChildEntry {
  threadId: string;
  harnessId: string;
  title?: string | undefined;
  status: ThreadTreeStatus;
}

/** The most urgent state among the children, which colors the badge. */
export function delegationBadgeState(
  children: readonly Pick<DelegationChildEntry, "status">[],
): ThreadTreeStatus {
  return children.reduce<ThreadTreeStatus>(
    (state, child) => (STATE_PRIORITY[child.status] < STATE_PRIORITY[state] ? child.status : state),
    "idle",
  );
}

function markExtensionNode<T extends Element>(node: T): T {
  node.setAttribute(EXTENSION_NODE_ATTRIBUTE, "");
  return node;
}

function findSidebarAgentIcon(rowElement: HTMLElement): HTMLElement | null {
  const icon = rowElement.querySelector<HTMLElement>(SIDEBAR_AGENT_ICON_SELECTOR);
  return icon && rowElement.contains(icon) ? icon : null;
}

function collectSidebarIcons(rows: readonly DesktopSidebarRow[]): Map<string, Element> {
  const icons = new Map<string, Element>();
  for (const row of rows) {
    if (!row.isConnected()) continue;
    const iconHost = findSidebarAgentIcon(row.element);
    if (!iconHost) continue;
    const harnessId = iconHost.getAttribute(SIDEBAR_AGENT_ICON_ATTRIBUTE);
    if (!harnessId || icons.has(harnessId)) continue;
    const graphic = iconHost.querySelector(":scope > img, :scope > svg");
    if (graphic) icons.set(harnessId, graphic);
  }
  return icons;
}

function harnessLabel(api: DesktopExtensionApiV1, harnessId: string): string {
  return api.harnesses.describe(harnessId)?.name ?? (harnessId === "codex" ? "Codex" : harnessId);
}

function createAgentIcon(
  api: DesktopExtensionApiV1,
  doc: Document,
  harnessId: string,
  sidebarIcons: ReadonlyMap<string, Element>,
): HTMLElement {
  const wrap = doc.createElement("span");
  wrap.className = "cx-delegation-icon";
  wrap.setAttribute("aria-hidden", "true");

  const described = api.harnesses.describe(harnessId);
  if (described?.icon) {
    const img = doc.createElement("img");
    img.src = described.icon;
    img.alt = "";
    img.draggable = false;
    wrap.append(img);
    return wrap;
  }

  const sampled = sidebarIcons.get(harnessId);
  if (sampled) {
    const tag = sampled.tagName.toLowerCase();
    if (tag === "img") {
      const src = sampled.getAttribute("src");
      if (src) {
        const img = doc.createElement("img");
        img.src = src;
        img.alt = "";
        img.draggable = false;
        wrap.append(img);
        return wrap;
      }
    } else if (tag === "svg") {
      const clone = sampled.cloneNode(true) as SVGElement;
      clone.style.width = "14px";
      clone.style.height = "14px";
      clone.style.flex = "none";
      wrap.append(clone);
      return wrap;
    }
  }

  wrap.classList.add("cx-delegation-icon-fallback");
  wrap.textContent = harnessLabel(api, harnessId).slice(0, 1).toUpperCase();
  return wrap;
}

function byUrgency(list: readonly DelegationChildEntry[]): DelegationChildEntry[] {
  return [...list].sort(
    (left, right) => STATE_PRIORITY[left.status] - STATE_PRIORITY[right.status],
  );
}

function createRowIconObserver(
  api: DesktopExtensionApiV1,
  onRelevantMutation: () => void,
): { sync(targets: ReadonlySet<HTMLElement>): void; disconnect(): void } {
  const observers = new Map<HTMLElement, MutationObserver>();
  let scheduled = false;

  const isExtensionOnlyNode = (node: Node): boolean =>
    node instanceof Element &&
    (node.hasAttribute(EXTENSION_NODE_ATTRIBUTE) ||
      Boolean(node.closest(`[${EXTENSION_NODE_ATTRIBUTE}]`)));

  const isRelevant = (mutations: readonly MutationRecord[]): boolean => {
    for (const mutation of mutations) {
      if (isExtensionOnlyNode(mutation.target)) continue;
      for (const node of mutation.addedNodes) {
        if (!isExtensionOnlyNode(node)) return true;
      }
      for (const node of mutation.removedNodes) {
        if (!isExtensionOnlyNode(node)) return true;
      }
    }
    return false;
  };

  const schedule = (): void => {
    if (scheduled || api.signal.aborted) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (api.signal.aborted) return;
      onRelevantMutation();
    });
  };

  const disconnect = (): void => {
    for (const observer of observers.values()) observer.disconnect();
    observers.clear();
  };

  api.track(disconnect);
  api.signal.addEventListener("abort", disconnect, { once: true });

  return {
    sync(targets) {
      if (api.signal.aborted) return;
      for (const [element, observer] of observers) {
        if (targets.has(element) && element.isConnected) continue;
        observer.disconnect();
        observers.delete(element);
      }
      for (const element of targets) {
        if (observers.has(element) || !element.isConnected) continue;
        const view = element.ownerDocument.defaultView;
        const ObserverCtor = view?.MutationObserver ?? globalThis.MutationObserver;
        if (!ObserverCtor) continue;
        const observer = new ObserverCtor((mutations) => {
          if (api.signal.aborted) return;
          if (isRelevant(mutations)) schedule();
        });
        observer.observe(element, { childList: true, subtree: true });
        observers.set(element, observer);
      }
    },
    disconnect,
  };
}

interface MountedBadge {
  icon: HTMLElement;
  button: HTMLButtonElement;
  count: HTMLSpanElement;
  threadId: string;
  presentation: string;
  dispose: () => void;
}

interface OpenPopover {
  parentThreadId: string;
  anchor: HTMLButtonElement;
  update(
    children: readonly DelegationChildEntry[],
    sidebarIcons: ReadonlyMap<string, Element>,
  ): void;
  setAnchor(nextAnchor: HTMLButtonElement): void;
  close(): void;
}

export function activate(api: DesktopExtensionApiV1): () => void {
  let rows: readonly DesktopSidebarRow[] = [];
  let childrenByParent = new Map<string, readonly DelegationChildEntry[]>();
  let treeTruncated = false;
  const badgesByRow = new Map<HTMLElement, MountedBadge>();
  let markedIcons = new Set<HTMLElement>();
  let popover: OpenPopover | null = null;

  const closePopover = (): void => {
    popover?.close();
    popover = null;
  };

  const itemsIn = (element: HTMLElement): HTMLElement[] => [
    ...element.querySelectorAll<HTMLElement>(`[${CHILD_ATTRIBUTE}]`),
  ];

  const placePopover = (element: HTMLElement, anchor: HTMLElement): void => {
    const view = element.ownerDocument.defaultView;
    if (!view) return;
    // The width cap applies before the list is measured for the left edge.
    element.style.maxWidth = `${Math.min(POPOVER_MAX_WIDTH, view.innerWidth - 2 * VIEWPORT_MARGIN)}px`;
    const rect = anchor.getBoundingClientRect();
    const below = view.innerHeight - rect.bottom - POPOVER_GAP - VIEWPORT_MARGIN;
    const above = rect.top - POPOVER_GAP - VIEWPORT_MARGIN;
    // Opens downward unless the list fits better above the icon.
    const wanted = Math.min(POPOVER_MAX_HEIGHT, element.scrollHeight);
    const upward = below < wanted && above > below;
    Object.assign(element.style, {
      maxHeight: `${Math.max(0, Math.min(POPOVER_MAX_HEIGHT, upward ? above : below))}px`,
      top: upward ? "auto" : `${Math.round(rect.bottom + POPOVER_GAP)}px`,
      bottom: upward ? `${Math.round(view.innerHeight - rect.top + POPOVER_GAP)}px` : "auto",
      left: `${Math.round(
        Math.max(
          VIEWPORT_MARGIN,
          Math.min(rect.left, view.innerWidth - VIEWPORT_MARGIN - element.offsetWidth),
        ),
      )}px`,
    } satisfies Partial<CSSStyleDeclaration>);
  };

  const renderPopoverItems = (
    element: HTMLElement,
    list: readonly DelegationChildEntry[],
    sidebarIcons: ReadonlyMap<string, Element>,
  ): void => {
    const doc = element.ownerDocument;
    const ordered = byUrgency(list);
    const titleOf = (child: DelegationChildEntry): string =>
      child.title?.trim() ? child.title : harnessLabel(api, child.harnessId);

    // The Harness presentation is part of the key: the plugin catalog or sidebar icons may load after opening.
    const presentation = JSON.stringify([
      treeTruncated,
      ordered.map((child) => {
        const described = api.harnesses.describe(child.harnessId);
        return [
          child.threadId,
          child.status,
          titleOf(child),
          child.harnessId,
          described?.name ?? null,
          described?.icon ?? null,
          sidebarIcons.has(child.harnessId),
        ];
      }),
    ]);
    if (element.getAttribute(POPOVER_ATTRIBUTE) === presentation) return;
    element.setAttribute(POPOVER_ATTRIBUTE, presentation);

    // Rebuilt items keep keyboard focus on the same child.
    const focused = doc.activeElement
      ?.closest(`[${CHILD_ATTRIBUTE}]`)
      ?.getAttribute(CHILD_ATTRIBUTE);
    element.replaceChildren();

    for (const child of ordered) {
      const state = child.status;
      const item = doc.createElement("button");
      item.type = "button";
      item.className = "cx-delegation-item";
      item.setAttribute("role", "menuitem");
      item.setAttribute(CHILD_ATTRIBUTE, child.threadId);

      const icon = createAgentIcon(api, doc, child.harnessId, sidebarIcons);

      const title = doc.createElement("span");
      title.className = "cx-delegation-title";
      title.textContent = titleOf(child);

      const status = doc.createElement("span");
      status.className = "cx-delegation-status";
      status.dataset.state = state;
      status.textContent = `${STATE_GLYPH[state]} ${STATE_LABEL[state]}`;

      item.append(icon, title, status);
      item.addEventListener(
        "click",
        (event) => {
          event.preventDefault();
          event.stopPropagation();
          closePopover();
          void api.navigate.openThread(child.threadId).catch((error: unknown) => {
            if (!api.signal.aborted) {
              console.error("codexhost could not open the delegated Thread", error);
            }
          });
        },
        { signal: api.signal },
      );
      element.append(item);
      if (child.threadId === focused) item.focus();
    }

    if (treeTruncated) {
      const note = doc.createElement("div");
      note.className = "cx-delegation-truncated";
      note.textContent = "会话树已截断，列表可能不完整";
      element.append(note);
    }
  };

  const openPopover = (
    anchor: HTMLButtonElement,
    parentThreadId: string,
    byKeyboard: boolean,
  ): void => {
    if (api.signal.aborted) return;
    closePopover();
    let list = childrenByParent.get(parentThreadId);
    if (!list?.length) return;

    const doc = anchor.ownerDocument;
    const element = markExtensionNode(doc.createElement("div"));
    element.className = "cx-delegation-popover";
    element.setAttribute(POPOVER_ATTRIBUTE, "");
    element.setAttribute("role", "menu");

    const popoverAbort = new AbortController();
    let currentAnchor = anchor;
    currentAnchor.setAttribute("aria-expanded", "true");

    const renderList = (sidebarIcons: ReadonlyMap<string, Element>): void => {
      renderPopoverItems(element, list ?? [], sidebarIcons);
      placePopover(element, currentAnchor);
    };

    const onPointerDown = (event: Event): void => {
      if (!(event.target instanceof Node) || !element.contains(event.target)) {
        closePopover();
      }
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        const returnFocus = element.contains(doc.activeElement);
        closePopover();
        if (returnFocus && currentAnchor.isConnected) currentAnchor.focus();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const entries = itemsIn(element);
      const index = entries.findIndex((entry) => entry === doc.activeElement);
      if (index < 0) return;
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      entries[(index + step + entries.length) % entries.length]?.focus();
    };

    doc.addEventListener("pointerdown", onPointerDown, {
      capture: true,
      signal: popoverAbort.signal,
    });
    doc.addEventListener("keydown", onKeyDown, {
      capture: true,
      signal: popoverAbort.signal,
    });
    api.dom.mount(element, doc.body, "append");

    const opened: OpenPopover = {
      parentThreadId,
      get anchor() {
        return currentAnchor;
      },
      setAnchor(nextAnchor) {
        if (currentAnchor === nextAnchor) return;
        currentAnchor.setAttribute("aria-expanded", "false");
        currentAnchor = nextAnchor;
        currentAnchor.setAttribute("aria-expanded", "true");
        placePopover(element, currentAnchor);
      },
      update(next, sidebarIcons) {
        list = next;
        renderList(sidebarIcons);
      },
      close() {
        popoverAbort.abort();
        currentAnchor.setAttribute("aria-expanded", "false");
        element.remove();
      },
    };
    popover = opened;
    renderList(collectSidebarIcons(rows));
    if (byKeyboard) itemsIn(element)[0]?.focus();
  };

  const unmountBadge = (rowElement: HTMLElement): void => {
    const existing = badgesByRow.get(rowElement);
    if (!existing) return;
    existing.dispose();
    badgesByRow.delete(rowElement);
  };

  const createBadge = (icon: HTMLElement, threadId: string, presentation: string): MountedBadge => {
    const doc = icon.ownerDocument;
    const badgeAbort = new AbortController();

    const button = markExtensionNode(doc.createElement("button"));
    button.type = "button";
    button.className = "cx-delegation-badge";
    button.setAttribute(BADGE_ATTRIBUTE, presentation);
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");

    const count = doc.createElement("span");
    count.className = "cx-delegation-count";
    button.append(count);

    const open = (event: Event, byKeyboard: boolean): void => {
      event.preventDefault();
      event.stopPropagation();
      openPopover(button, current.threadId, byKeyboard);
    };
    const swallow = (event: Event): void => {
      event.stopPropagation();
    };
    const onClick = (event: Event): void => open(event, false);
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Enter" || event.key === " ") open(event, true);
    };

    // The row navigates on press; keep the icon's own press from reaching it.
    for (const type of PRESS_EVENTS) {
      button.addEventListener(type, swallow, { signal: badgeAbort.signal });
    }
    button.addEventListener("click", onClick, { signal: badgeAbort.signal });
    button.addEventListener("keydown", onKeyDown, { signal: badgeAbort.signal });

    api.dom.mount(button, icon, "append");

    const current: MountedBadge = {
      icon,
      button,
      count,
      threadId,
      presentation,
      dispose() {
        badgeAbort.abort();
        button.remove();
      },
    };
    return current;
  };

  const render = (): void => {
    if (api.signal.aborted) return;
    const visibleRows = new Set<HTMLElement>();
    const observedRows = new Set<HTMLElement>();
    const nextMarkedIcons = new Set<HTMLElement>();
    const sidebarIcons = collectSidebarIcons(rows);

    for (const row of rows) {
      if (!row.isLocal || !row.threadId || !row.isConnected()) continue;
      const list = childrenByParent.get(row.threadId);
      if (!list?.length) continue;

      observedRows.add(row.element);
      const icon = findSidebarAgentIcon(row.element);
      if (!icon) continue;

      visibleRows.add(row.element);
      nextMarkedIcons.add(icon);

      const state = delegationBadgeState(list);
      const presentation = `${row.threadId}:${list.length}:${state}:${treeTruncated ? "1" : "0"}`;
      let badge = badgesByRow.get(row.element);

      if (badge && (badge.icon !== icon || badge.button.parentElement !== icon)) {
        unmountBadge(row.element);
        badge = undefined;
      }

      if (!badge) {
        badge = createBadge(icon, row.threadId, presentation);
        badgesByRow.set(row.element, badge);
      } else if (badge.presentation === presentation) {
        if (popover?.parentThreadId === row.threadId && popover.anchor !== badge.button) {
          popover.setAnchor(badge.button);
        }
        continue;
      } else {
        badge.threadId = row.threadId;
        badge.presentation = presentation;
        badge.button.setAttribute(BADGE_ATTRIBUTE, presentation);
      }

      const originalLabel = icon.getAttribute("aria-label") ?? "";
      const label = `${originalLabel} · 已派出 ${list.length} 个会话${state === "idle" ? "" : `，有会话${STATE_LABEL[state]}`}${treeTruncated ? "（列表可能不完整）" : ""}`;
      badge.button.setAttribute("aria-label", label);
      badge.button.title = label;
      badge.count.dataset.state = state;
      badge.count.textContent = list.length > 9 ? "9+" : String(list.length);

      if (popover?.parentThreadId === row.threadId && popover.anchor !== badge.button) {
        popover.setAnchor(badge.button);
      }
    }

    for (const icon of markedIcons) {
      if (!nextMarkedIcons.has(icon)) api.dom.unmark(icon, "anchor");
    }
    for (const icon of nextMarkedIcons) {
      if (!markedIcons.has(icon)) api.dom.mark(icon, "anchor");
    }
    markedIcons = nextMarkedIcons;

    for (const rowElement of [...badgesByRow.keys()]) {
      if (!visibleRows.has(rowElement)) unmountBadge(rowElement);
    }

    if (popover) {
      const list = childrenByParent.get(popover.parentThreadId);
      if (!list?.length || !popover.anchor.isConnected) {
        closePopover();
      } else {
        popover.update(list, sidebarIcons);
      }
    }

    iconObserver.sync(observedRows);
  };

  const iconObserver = createRowIconObserver(api, render);

  const cleanup = (): void => {
    closePopover();
    iconObserver.disconnect();
    for (const rowElement of [...badgesByRow.keys()]) unmountBadge(rowElement);
    if (!api.signal.aborted) {
      for (const icon of markedIcons) api.dom.unmark(icon, "anchor");
    }
    markedIcons.clear();
  };

  api.signal.addEventListener("abort", cleanup, { once: true });

  api.sidebar.observeRows((current) => {
    rows = current;
    render();
  });

  api.threads.watchTree(({ nodes, parents, truncated }) => {
    treeTruncated = truncated;
    const next = new Map<string, DelegationChildEntry[]>();
    const nodeById = new Map<string, ThreadTreeNode>(Object.entries(nodes));
    for (const [childId, parentId] of Object.entries(parents)) {
      const child = nodeById.get(childId);
      const parent = nodeById.get(parentId);
      if (!child || child.archived || !parent || parent.archived) continue;
      const list = next.get(parentId) ?? [];
      list.push({
        threadId: childId,
        harnessId: child.harnessId,
        title: child.title,
        status: child.status,
      });
      next.set(parentId, list);
    }
    childrenByParent = next;
    render();
  });

  return cleanup;
}
