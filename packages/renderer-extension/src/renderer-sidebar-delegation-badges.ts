import {
  DELEGATION_CHILDREN_MAX_PARENTS,
  hostThreadIdSchema,
  type DelegationChild,
  type DelegationChildStatus,
  type HarnessPluginDescriptor,
} from "@codexhost/shared-contracts";

import { createRendererAgentIcon, rendererAgentLabel } from "./renderer-agent-icon.js";
import type { RendererModelClient } from "./renderer-model-client.js";
import {
  SIDEBAR_AGENT_ICON_ATTRIBUTE,
  SIDEBAR_THREAD_HOST_ID_ATTRIBUTE,
  SIDEBAR_THREAD_ROW_SELECTOR,
  threadIdFromSidebarRowElement,
} from "./renderer-sidebar-agent-icons.js";

/**
 * Corner count on the Agent icon of a Thread whose children appear under it in the Web Thread
 * tree, colored by the most urgent child state (question, then running); the icon then opens a
 * popover listing each child, most urgent first, with its state. The badge only reads, and
 * opening a child uses Desktop's own router. Badges and the open list share one source, the
 * periodic poll; opening the list only adds the official titles of native Codex children.
 */

const BADGE_ATTRIBUTE = "data-codexhost-delegation-badge";
const POPOVER_ATTRIBUTE = "data-codexhost-delegation-popover";
const CHILD_ATTRIBUTE = "data-codexhost-delegation-child";
const LOCAL_HOST_ID = "local";
const POLL_INTERVAL_MS = 5_000;
const SIDEBAR_SCROLL_SELECTOR = "[data-app-action-sidebar-scroll]";
const POPOVER_MAX_HEIGHT = 320;
const POPOVER_MAX_WIDTH = 360;
const POPOVER_GAP = 4;
const VIEWPORT_MARGIN = 8;

const STATE_PRIORITY: Record<DelegationChildStatus, number> = { question: 0, running: 1, idle: 2 };
const STATE_LABEL: Record<DelegationChildStatus, string> = {
  question: "待回答",
  running: "运行中",
  idle: "无活动",
};
const STATE_GLYPH: Record<DelegationChildStatus, string> = {
  question: "?",
  running: "●",
  idle: "○",
};
const STATE_COLOR: Record<DelegationChildStatus, string> = {
  question: "#f5a524",
  running: "#3e9bff",
  idle: "color-mix(in srgb, currentColor 45%, transparent)",
};

/** The most urgent state among the children, which colors the badge. */
export function delegationBadgeState(
  children: readonly Pick<DelegationChild, "status">[],
): DelegationChildStatus {
  return children.reduce<DelegationChildStatus>(
    (state, child) => (STATE_PRIORITY[child.status] < STATE_PRIORITY[state] ? child.status : state),
    "idle",
  );
}

export interface RendererSidebarDelegationBadges {
  dispose(): void;
}

export function installRendererSidebarDelegationBadges(options: {
  getClient(hostId: string): RendererModelClient | null;
  getPlugins?(hostId: string): readonly HarnessPluginDescriptor[] | undefined;
  openThread(threadId: string): Promise<void>;
  root?: Document;
}): RendererSidebarDelegationBadges {
  const root = options.root ?? document;
  const view = root.defaultView ?? window;
  let children = new Map<string, readonly DelegationChild[]>();
  let disposed = false;
  let polling = false;
  let applyScheduled = false;
  let popover: {
    parentThreadId: string;
    update(children: readonly DelegationChild[]): void;
    close(): void;
  } | null = null;

  const localRows = (): { element: HTMLElement; threadId: string }[] => {
    const rows: { element: HTMLElement; threadId: string }[] = [];
    for (const element of root.querySelectorAll<HTMLElement>(SIDEBAR_THREAD_ROW_SELECTOR)) {
      if (element.getAttribute(SIDEBAR_THREAD_HOST_ID_ATTRIBUTE) !== LOCAL_HOST_ID) continue;
      const threadId = threadIdFromSidebarRowElement(element);
      if (threadId) rows.push({ element, threadId });
    }
    return rows;
  };

  const plugin = (harnessId: string): HarnessPluginDescriptor | undefined =>
    harnessId === "codex"
      ? undefined
      : options.getPlugins?.(LOCAL_HOST_ID)?.find(({ id }) => id === harnessId);

  const closePopover = (): void => {
    popover?.close();
    popover = null;
  };

  // The Host lists newest first; more urgent states move to the top, keeping that order.
  const byUrgency = (list: readonly DelegationChild[]): DelegationChild[] =>
    list.toSorted((left, right) => STATE_PRIORITY[left.status] - STATE_PRIORITY[right.status]);

  const renderItems = (
    element: HTMLElement,
    list: readonly DelegationChild[],
    titles: ReadonlyMap<string, string>,
  ): void => {
    const ordered = byUrgency(list);
    const titleOf = (child: DelegationChild): string =>
      child.title ??
      titles.get(child.threadId) ??
      rendererAgentLabel(child.harnessId, plugin(child.harnessId));
    // The Harness presentation is part of the key: the plugin catalog may load after opening.
    const presentation = JSON.stringify(
      ordered.map((child) => [
        child.threadId,
        child.status,
        titleOf(child),
        child.harnessId,
        plugin(child.harnessId)?.id ?? null,
      ]),
    );
    if (element.getAttribute(POPOVER_ATTRIBUTE) === presentation) return;
    element.setAttribute(POPOVER_ATTRIBUTE, presentation);
    // Rebuilt items keep keyboard focus on the same child.
    const focused = root.activeElement
      ?.closest(`[${CHILD_ATTRIBUTE}]`)
      ?.getAttribute(CHILD_ATTRIBUTE);
    element.replaceChildren();
    for (const child of ordered) {
      const state = child.status;
      const item = root.createElement("button");
      item.type = "button";
      item.setAttribute("role", "menuitem");
      item.setAttribute(CHILD_ATTRIBUTE, child.threadId);
      Object.assign(item.style, {
        display: "flex",
        alignItems: "center",
        gap: "6px",
        width: "100%",
        padding: "5px 6px",
        border: "0",
        borderRadius: "5px",
        background: "transparent",
        color: "inherit",
        font: "inherit",
        textAlign: "left",
        cursor: "pointer",
      } satisfies Partial<CSSStyleDeclaration>);
      item.addEventListener("mouseenter", () => {
        item.style.background = "color-mix(in srgb, currentColor 8%, transparent)";
      });
      item.addEventListener("mouseleave", () => {
        item.style.background = "transparent";
      });

      const icon = createRendererAgentIcon(child.harnessId, 14, root, plugin(child.harnessId));
      const title = root.createElement("span");
      title.textContent = titleOf(child);
      Object.assign(title.style, {
        flex: "1",
        minWidth: "0",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      } satisfies Partial<CSSStyleDeclaration>);
      const status = root.createElement("span");
      status.textContent = `${STATE_GLYPH[state]} ${STATE_LABEL[state]}`;
      Object.assign(status.style, {
        flex: "none",
        opacity: state === "idle" ? "0.6" : "1",
        color: state === "question" ? STATE_COLOR.question : "inherit",
      } satisfies Partial<CSSStyleDeclaration>);
      item.append(icon, title, status);
      item.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        closePopover();
        void options.openThread(child.threadId).catch((error: unknown) => {
          console.error("codexhost could not open the delegated Thread", error);
        });
      });
      element.append(item);
      if (child.threadId === focused) item.focus();
    }
  };

  const place = (element: HTMLElement, anchor: HTMLElement): void => {
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

  const items = (element: HTMLElement): HTMLElement[] => [
    ...element.querySelectorAll<HTMLElement>(`[${CHILD_ATTRIBUTE}]`),
  ];

  const openPopover = (anchor: HTMLElement, parentThreadId: string, byKeyboard: boolean): void => {
    closePopover();
    let list = children.get(parentThreadId);
    if (!list?.length) return;
    // Native Codex titles cost an official read each, so the open list asks for each one once;
    // statuses keep following the poll.
    const titles = new Map<string, string>();
    const requested = new Set<string>();

    const element = root.createElement("div");
    element.setAttribute(POPOVER_ATTRIBUTE, "");
    element.setAttribute("role", "menu");
    Object.assign(element.style, {
      position: "fixed",
      zIndex: "2147483000",
      minWidth: "220px",
      overflowY: "auto",
      padding: "4px",
      borderRadius: "8px",
      border: "1px solid color-mix(in srgb, currentColor 14%, transparent)",
      background: "Canvas",
      color: "CanvasText",
      boxShadow: "0 8px 24px rgb(0 0 0 / 24%)",
      font: "12px/1.4 system-ui, -apple-system, sans-serif",
    } satisfies Partial<CSSStyleDeclaration>);

    const render = (): void => {
      renderItems(element, list ?? [], titles);
      place(element, anchor);
    };
    const fillTitles = (): void => {
      const missing = (list ?? []).filter(
        (child) => child.harnessId === "codex" && !child.title && !requested.has(child.threadId),
      );
      const client = options.getClient(LOCAL_HOST_ID);
      if (missing.length === 0 || !client?.listDelegationChildren) return;
      for (const child of missing) requested.add(child.threadId);
      client
        .listDelegationChildren({
          threadIds: [hostThreadIdSchema.parse(parentThreadId)],
          includeTitles: true,
        })
        .then((result) => {
          if (popover !== opened) return;
          for (const child of result.parents[0]?.children ?? [])
            if (child.title) titles.set(child.threadId, child.title);
          render();
        })
        .catch((error: unknown) => {
          console.error("codexhost could not read delegated Thread titles", error);
        });
    };

    const onPointerDown = (event: Event): void => {
      if (!(event.target instanceof Node) || !element.contains(event.target)) closePopover();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        const returnFocus = element.contains(root.activeElement);
        closePopover();
        if (returnFocus && anchor.isConnected) anchor.focus();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const entries = items(element);
      const index = entries.findIndex((entry) => entry === root.activeElement);
      if (index < 0) return;
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      entries[(index + step + entries.length) % entries.length]?.focus();
    };
    root.addEventListener("pointerdown", onPointerDown, true);
    root.addEventListener("keydown", onKeyDown, true);
    root.body.append(element);
    const opened = {
      parentThreadId,
      update(next: readonly DelegationChild[]) {
        list = next;
        render();
        fillTitles();
      },
      close() {
        root.removeEventListener("pointerdown", onPointerDown, true);
        root.removeEventListener("keydown", onKeyDown, true);
        element.remove();
      },
    };
    popover = opened;
    render();
    if (byKeyboard) items(element)[0]?.focus();
    fillTitles();
  };

  // The badge decorates the row's Agent icon, which `renderer-sidebar-agent-icons` owns and may
  // recreate; a recreated icon is decorated again on the next sidebar mutation.
  const decorations = new WeakMap<HTMLElement, () => void>();

  const undecorate = (icon: HTMLElement): void => {
    decorations.get(icon)?.();
    decorations.delete(icon);
  };

  const renderBadge = (row: HTMLElement, threadId: string): void => {
    const icon = row.querySelector<HTMLElement>(`[${SIDEBAR_AGENT_ICON_ATTRIBUTE}]`);
    if (!icon) return;
    const list = children.get(threadId) ?? [];
    if (list.length === 0) {
      undecorate(icon);
      return;
    }
    const state = delegationBadgeState(list);
    const presentation = `${threadId}:${list.length}:${state}`;
    if (icon.getAttribute(BADGE_ATTRIBUTE) === presentation) return;
    undecorate(icon);

    const original = {
      title: icon.title,
      label: icon.getAttribute("aria-label"),
      role: icon.getAttribute("role"),
      style: icon.getAttribute("style"),
    };
    const label = `${original.label ?? ""} · 已派出 ${list.length} 个会话${state === "idle" ? "" : `，有会话${STATE_LABEL[state]}`}`;
    icon.setAttribute(BADGE_ATTRIBUTE, presentation);
    icon.setAttribute("role", "button");
    icon.setAttribute("aria-label", label);
    icon.title = label;
    icon.tabIndex = 0;
    Object.assign(icon.style, {
      position: "relative",
      pointerEvents: "auto",
      cursor: "pointer",
    } satisfies Partial<CSSStyleDeclaration>);

    const count = root.createElement("span");
    count.textContent = list.length > 9 ? "9+" : String(list.length);
    Object.assign(count.style, {
      position: "absolute",
      right: "-6px",
      bottom: "-4px",
      minWidth: "11px",
      height: "11px",
      padding: "0 2px",
      boxSizing: "border-box",
      borderRadius: "6px",
      background: STATE_COLOR[state],
      color: "#fff",
      font: "600 8px/11px system-ui, -apple-system, sans-serif",
      textAlign: "center",
      pointerEvents: "none",
    } satisfies Partial<CSSStyleDeclaration>);
    icon.append(count);

    const open = (event: Event, byKeyboard: boolean): void => {
      event.preventDefault();
      event.stopPropagation();
      openPopover(icon, threadId, byKeyboard);
    };
    const onClick = (event: Event): void => open(event, false);
    const swallow = (event: Event): void => event.stopPropagation();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Enter" || event.key === " ") open(event, true);
    };
    // The row navigates on press; keep the icon's own press from reaching it.
    const pressEvents = ["pointerdown", "mousedown", "pointerup", "mouseup"] as const;
    for (const type of pressEvents) icon.addEventListener(type, swallow);
    icon.addEventListener("click", onClick);
    icon.addEventListener("keydown", onKeyDown);
    decorations.set(icon, () => {
      for (const type of pressEvents) icon.removeEventListener(type, swallow);
      icon.removeEventListener("click", onClick);
      icon.removeEventListener("keydown", onKeyDown);
      count.remove();
      icon.removeAttribute(BADGE_ATTRIBUTE);
      icon.removeAttribute("tabindex");
      icon.title = original.title;
      for (const [name, value] of [
        ["aria-label", original.label],
        ["role", original.role],
        ["style", original.style],
      ] as const) {
        if (value === null) icon.removeAttribute(name);
        else icon.setAttribute(name, value);
      }
    });
  };

  const apply = (): void => {
    applyScheduled = false;
    if (disposed) return;
    const rows = localRows();
    // A row element Desktop reuses for a remote Thread keeps no badge.
    for (const icon of root.querySelectorAll<HTMLElement>(`[${BADGE_ATTRIBUTE}]`))
      if (!rows.some(({ element }) => element.contains(icon))) undecorate(icon);
    for (const { element, threadId } of rows) renderBadge(element, threadId);
  };

  const scheduleApply = (): void => {
    if (disposed || applyScheduled) return;
    applyScheduled = true;
    view.requestAnimationFrame(apply);
  };

  const poll = async (): Promise<void> => {
    if (disposed || polling || root.visibilityState === "hidden") return;
    observeSidebar();
    const client = options.getClient(LOCAL_HOST_ID);
    if (!client?.listDelegationChildren) return;
    const threadIds = [
      ...new Set(localRows().map(({ threadId }) => hostThreadIdSchema.parse(threadId))),
    ];
    if (threadIds.length === 0) return;
    polling = true;
    // A poll that the page, the Host client or disposal outdates mid-way commits nothing.
    const current = (): boolean =>
      !disposed && root.visibilityState !== "hidden" && options.getClient(LOCAL_HOST_ID) === client;
    try {
      const next = new Map<string, readonly DelegationChild[]>();
      for (let index = 0; index < threadIds.length; index += DELEGATION_CHILDREN_MAX_PARENTS) {
        if (!current()) return;
        const result = await client.listDelegationChildren({
          threadIds: threadIds.slice(index, index + DELEGATION_CHILDREN_MAX_PARENTS),
        });
        for (const parent of result.parents)
          if (parent.children.length > 0) next.set(parent.threadId, parent.children);
      }
      if (!current()) return;
      children = next;
      scheduleApply();
      // An open list follows the same poll as the badges, when the poll covered its parent.
      if (popover && threadIds.includes(hostThreadIdSchema.parse(popover.parentThreadId))) {
        const list = next.get(popover.parentThreadId);
        if (list) popover.update(list);
        else closePopover();
      }
    } catch {
      // Older or unreachable Hosts: keep the last known badges and try on the next tick.
    } finally {
      polling = false;
    }
  };

  // Desktop re-renders and virtualizes rows; badges are restored from the last poll. Only the
  // sidebar is observed: transcript streaming must not trigger row scans.
  let observed: Element | null = null;
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      const target =
        mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
      if (target?.closest(`[${BADGE_ATTRIBUTE}], [${POPOVER_ATTRIBUTE}]`)) continue;
      scheduleApply();
      return;
    }
  });
  const observeSidebar = (): void => {
    const sidebar = root.querySelector(SIDEBAR_SCROLL_SELECTOR);
    if (sidebar === observed) return;
    observer.disconnect();
    observed = sidebar;
    if (sidebar) observer.observe(sidebar, { childList: true, subtree: true });
  };
  const timer = view.setInterval(() => void poll(), POLL_INTERVAL_MS);
  const onVisibility = (): void => void poll();
  root.addEventListener("visibilitychange", onVisibility);
  void poll();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      view.clearInterval(timer);
      root.removeEventListener("visibilitychange", onVisibility);
      closePopover();
      for (const icon of root.querySelectorAll<HTMLElement>(`[${BADGE_ATTRIBUTE}]`))
        undecorate(icon);
    },
  };
}
