import type {
  DesktopExtensionApiV1,
  DesktopSidebarRow,
  ThreadTreeNode,
} from "@codexhost/shared-contracts";
import {
  collectSidebarIcons,
  createRowIconObserverManager,
  createThreadIcon,
  findSidebarAgentIcon,
  isZhDocument,
  localizedStatusLabel,
  markExtensionNode,
  openThread,
  statusPriority,
  stopRowPointerPropagation,
  threadAccessibleTitle,
} from "../../src/presentation.js";

type Child = readonly [id: string, node: ThreadTreeNode];

interface BadgeHandle {
  element: HTMLElement;
  trigger: HTMLButtonElement;
  panel: HTMLElement;
  supportsPopover: boolean;
}

function positionPanel(rowElement: HTMLElement, trigger: HTMLElement, panel: HTMLElement): void {
  const view = panel.ownerDocument.defaultView;
  if (!view) return;
  const rowRect = rowElement.getBoundingClientRect();
  const anchorRect =
    rowRect.width > 0 || rowRect.height > 0 ? rowRect : trigger.getBoundingClientRect();
  if (anchorRect.width === 0 && anchorRect.height === 0) return;

  const viewportWidth = view.innerWidth || 1024;
  const viewportHeight = view.innerHeight || 768;
  const panelRect = panel.getBoundingClientRect();
  const panelWidth = panelRect.width > 0 ? panelRect.width : 260;
  const panelHeight = panelRect.height > 0 ? panelRect.height : 180;
  const margin = 8;
  const gap = 4;

  const left = Math.max(margin, Math.min(anchorRect.left + 8, viewportWidth - panelWidth - margin));
  let top = anchorRect.bottom + gap;
  if (top + panelHeight > viewportHeight - margin && anchorRect.top - gap - panelHeight >= margin) {
    top = anchorRect.top - gap - panelHeight;
  } else {
    top = Math.max(margin, Math.min(top, viewportHeight - panelHeight - margin));
  }

  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
}

function hidePanel(badge: BadgeHandle): void {
  if (badge.supportsPopover) {
    if (badge.panel.matches(":popover-open")) badge.panel.hidePopover();
  } else {
    badge.panel.hidden = true;
    badge.trigger.setAttribute("aria-expanded", "false");
  }
}

export function activate(api: DesktopExtensionApiV1): void {
  let rows: readonly DesktopSidebarRow[] = [];
  let byParent = new Map<string, Child[]>();
  const badges = new Map<HTMLElement, BadgeHandle>();
  let markedIcons = new Set<HTMLElement>();

  const iconObserver = createRowIconObserverManager(api, () => render());

  function createBadge(rowElement: HTMLElement): BadgeHandle {
    const doc = rowElement.ownerDocument;
    const element = markExtensionNode(doc.createElement("span"));
    element.className = "cx-delegation-badge";

    const trigger = doc.createElement("button");
    trigger.type = "button";
    trigger.className = "cx-delegation-trigger";
    trigger.setAttribute("aria-haspopup", "true");
    trigger.setAttribute("aria-expanded", "false");

    const panel = markExtensionNode(doc.createElement("div"));
    panel.className = "cx-delegation-panel";
    panel.setAttribute("role", "dialog");

    const supportsPopover = typeof panel.showPopover === "function";
    const badge: BadgeHandle = { element, trigger, panel, supportsPopover };

    if (supportsPopover) {
      panel.popover = "auto";
      trigger.popoverTargetElement = panel;
      panel.addEventListener(
        "beforetoggle",
        (event) => {
          const toggleEvent = event as Event & { newState?: string };
          if (toggleEvent.newState === "open") positionPanel(rowElement, trigger, panel);
        },
        { signal: api.signal },
      );
      panel.addEventListener(
        "toggle",
        (event) => {
          const toggleEvent = event as Event & { newState?: string };
          const open = toggleEvent.newState === "open";
          trigger.setAttribute("aria-expanded", String(open));
          if (open) positionPanel(rowElement, trigger, panel);
        },
        { signal: api.signal },
      );
    } else {
      panel.hidden = true;
    }

    stopRowPointerPropagation(trigger, api.signal);
    stopRowPointerPropagation(panel, api.signal);

    trigger.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Enter" || event.key === " ") event.stopPropagation();
      },
      { signal: api.signal },
    );

    trigger.addEventListener(
      "click",
      (event) => {
        event.stopPropagation();
        if (!supportsPopover) {
          event.preventDefault();
          const nextOpen = panel.hidden;
          panel.hidden = !nextOpen;
          trigger.setAttribute("aria-expanded", String(nextOpen));
          if (nextOpen) positionPanel(rowElement, trigger, panel);
        }
      },
      { signal: api.signal },
    );

    panel.addEventListener(
      "click",
      (event) => {
        event.stopPropagation();
        if (!(event.target instanceof Element)) return;
        const id = event.target.closest<HTMLButtonElement>("button[data-thread]")?.dataset.thread;
        if (id) {
          hidePanel(badge);
          void openThread(api, id);
        }
      },
      { signal: api.signal },
    );

    element.append(trigger, panel);
    return badge;
  }

  function render(): void {
    if (api.signal.aborted) return;
    const visibleRows = new Set<HTMLElement>();
    const observedRows = new Set<HTMLElement>();
    const nextMarkedIcons = new Set<HTMLElement>();
    const sidebarIcons = collectSidebarIcons(rows);

    for (const row of rows) {
      if (!row.isLocal || !row.threadId || !row.isConnected()) continue;
      const children = byParent.get(row.threadId);
      const leading = children?.[0];
      if (!children || !leading) continue;

      observedRows.add(row.element);
      const icon = findSidebarAgentIcon(row.element);
      if (!icon) continue;

      visibleRows.add(row.element);
      nextMarkedIcons.add(icon);
      let badge = badges.get(row.element);
      if (!badge) {
        badge = createBadge(row.element);
        badges.set(row.element, badge);
      }

      if (badge.element.parentElement !== icon) {
        api.dom.mount(badge.element, icon, "append");
      }

      const doc = row.element.ownerDocument;
      const zh = isZhDocument(doc);
      const status = leading[1].status;
      badge.trigger.textContent = children.length > 9 ? "9+" : String(children.length);
      badge.trigger.dataset.state = status;

      const label = zh
        ? `${children.length} 个委派子会话 · ${localizedStatusLabel(status, true)}`
        : `${children.length} delegated ${children.length === 1 ? "Thread" : "Threads"} · ${localizedStatusLabel(status, false)}`;
      badge.trigger.title = label;
      badge.trigger.setAttribute("aria-label", label);
      badge.panel.setAttribute("aria-label", label);

      const list = doc.createDocumentFragment();
      for (const [id, child] of children) {
        const button = doc.createElement("button");
        button.type = "button";
        button.className = "cx-delegation-item";
        button.dataset.thread = id;
        button.dataset.state = child.status;

        const title = doc.createElement("span");
        title.className = "cx-delegation-title";
        title.textContent = child.title || id;

        const statusWrap = doc.createElement("span");
        statusWrap.className = "cx-delegation-status";
        statusWrap.dataset.state = child.status;

        const glyph = doc.createElement("span");
        glyph.className = "cx-delegation-status-glyph";
        glyph.setAttribute("aria-hidden", "true");
        if (child.status === "waiting") glyph.textContent = "?";

        const statusText = doc.createElement("span");
        statusText.className = "cx-delegation-status-text";
        statusText.textContent = localizedStatusLabel(child.status, zh);

        statusWrap.append(glyph, statusText);
        button.append(createThreadIcon(api, doc, child.harnessId, sidebarIcons), title, statusWrap);

        const accessible = threadAccessibleTitle(api, id, child, zh);
        button.title = accessible;
        button.setAttribute("aria-label", accessible);
        list.append(button);
      }
      badge.panel.replaceChildren(list);
    }

    for (const icon of markedIcons) {
      if (!nextMarkedIcons.has(icon)) api.dom.unmark(icon, "anchor");
    }
    for (const icon of nextMarkedIcons) {
      if (!markedIcons.has(icon)) api.dom.mark(icon, "anchor");
    }
    markedIcons = nextMarkedIcons;

    for (const [rowElement, badge] of badges) {
      if (visibleRows.has(rowElement)) continue;
      hidePanel(badge);
      badge.element.remove();
      badges.delete(rowElement);
    }

    iconObserver.sync(observedRows);
  }

  api.sidebar.observeRows((current) => {
    rows = current;
    render();
  });
  api.threads.watchTree(({ nodes, parents }) => {
    byParent = new Map();
    const nodeById = new Map(Object.entries(nodes));
    for (const [id, parent] of Object.entries(parents)) {
      const child = nodeById.get(id);
      const parentNode = nodeById.get(parent);
      if (!child || child.archived || !parentNode || parentNode.archived) continue;
      const list = byParent.get(parent) ?? [];
      list.push([id, child]);
      byParent.set(parent, list);
    }
    for (const list of byParent.values()) {
      list.sort(([, a], [, b]) => statusPriority[a.status] - statusPriority[b.status]);
    }
    render();
  });
}
