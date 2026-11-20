import type {
  DesktopExtensionApiV1,
  DesktopSidebarRow,
  ThreadTreeSnapshot,
  ThreadTreeStatus,
} from "@codexhost/shared-contracts";
import {
  collectSidebarIcons,
  createRowIconObserverManager,
  createThreadIcon,
  findSidebarAgentIcon,
  isZhDocument,
  markExtensionNode,
  openThread,
  stopRowPointerPropagation,
  threadAccessibleTitle,
} from "../../src/presentation.js";
import { planThreadTree, type DisplayThread } from "./tree.js";

type TreeMark =
  "hidden" | "replaced" | "root-row" | "icon-anchor" | "icon-expanded" | "icon-collapsed";

interface ListRowMetrics {
  rowHeight: number;
  borderRadius: string;
  fontSize: string;
  rowOffsetLeft: number;
  rowOffsetRight: number;
  iconSize: number;
  iconOffset: number;
  gap: number;
}

const DEFAULT_METRICS: ListRowMetrics = {
  rowHeight: 32,
  borderRadius: "8px",
  fontSize: "13px",
  rowOffsetLeft: 0,
  rowOffsetRight: 0,
  iconSize: 14,
  iconOffset: 10,
  gap: 8,
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function measureRowMetrics(
  rowElement: HTMLElement,
  itemElement: HTMLElement,
): ListRowMetrics | null {
  const rowRect = rowElement.getBoundingClientRect();
  if (rowRect.height <= 0 || rowRect.width <= 0) return null;
  const itemRect = itemElement.getBoundingClientRect();
  const view = rowElement.ownerDocument.defaultView;
  const rowStyle = view?.getComputedStyle(rowElement);
  const icon = findSidebarAgentIcon(rowElement);
  const title = rowElement.querySelector<HTMLElement>("[data-thread-title]");
  const titleStyle = title ? view?.getComputedStyle(title) : undefined;

  const iconRect = icon?.getBoundingClientRect();
  const titleRect = title?.getBoundingClientRect();

  const iconSize =
    iconRect && iconRect.width > 0
      ? clamp(Math.round(iconRect.width), 12, 20)
      : DEFAULT_METRICS.iconSize;
  const iconOffset =
    iconRect && iconRect.width > 0
      ? clamp(Math.round(iconRect.left - rowRect.left), 2, 40)
      : DEFAULT_METRICS.iconOffset;
  const gap =
    iconRect && titleRect && iconRect.width > 0 && titleRect.width > 0
      ? clamp(Math.round(titleRect.left - iconRect.right), 4, 16)
      : DEFAULT_METRICS.gap;

  const borderRadius =
    rowStyle?.borderRadius && rowStyle.borderRadius !== "0px"
      ? rowStyle.borderRadius
      : DEFAULT_METRICS.borderRadius;
  const fontSize =
    (titleStyle?.fontSize && titleStyle.fontSize !== "0px" ? titleStyle.fontSize : undefined) ??
    (rowStyle?.fontSize && rowStyle.fontSize !== "0px" ? rowStyle.fontSize : undefined) ??
    DEFAULT_METRICS.fontSize;

  return {
    rowHeight: clamp(Math.round(rowRect.height), 24, 48),
    borderRadius,
    fontSize,
    rowOffsetLeft: itemRect.width > 0 ? clamp(Math.round(rowRect.left - itemRect.left), 0, 32) : 0,
    rowOffsetRight:
      itemRect.width > 0 ? clamp(Math.round(itemRect.right - rowRect.right), 0, 32) : 0,
    iconSize,
    iconOffset,
    gap,
  };
}

function applyListMetrics(panel: HTMLElement, metrics: ListRowMetrics): void {
  panel.style.setProperty("--cx-tree-row-height", `${metrics.rowHeight}px`);
  panel.style.setProperty("--cx-tree-row-radius", metrics.borderRadius);
  panel.style.setProperty("--cx-tree-font-size", metrics.fontSize);
  panel.style.setProperty("--cx-tree-row-inset-start", `${metrics.rowOffsetLeft}px`);
  panel.style.setProperty("--cx-tree-row-inset-end", `${metrics.rowOffsetRight}px`);
  panel.style.setProperty("--cx-tree-icon-size", `${metrics.iconSize}px`);
  panel.style.setProperty("--cx-tree-icon-offset", `${metrics.iconOffset}px`);
  panel.style.setProperty("--cx-tree-gap", `${metrics.gap}px`);
}

function createChevronSvg(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 12 12");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "cx-tree-chevron");
  const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M3 4.5L6 7.5L9 4.5");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.5");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

function toggleLabel(descendants: number, open: boolean, zh: boolean): string {
  if (zh) return `${open ? "收起" : "展开"} ${descendants} 个子会话`;
  const noun = descendants === 1 ? "child" : "children";
  return `${open ? "Collapse" : "Expand"} ${descendants} ${noun}`;
}

function createStatusIndicator(doc: Document, status: ThreadTreeStatus): HTMLElement | null {
  if (status === "idle") return null;
  const indicator = doc.createElement("span");
  indicator.className = "cx-tree-status";
  indicator.dataset.state = status;
  indicator.setAttribute("aria-hidden", "true");
  return indicator;
}

function buildSummaryButton(
  doc: Document,
  thread: DisplayThread,
  depth: number,
  zh: boolean,
): HTMLButtonElement {
  const { descendants, running, waiting } = thread.activity;
  const button = doc.createElement("button");
  button.type = "button";
  button.className = "cx-tree-summary";
  button.dataset.branch = thread.id;
  button.style.setProperty("--cx-tree-depth", String(Math.min(depth, 3)));
  button.setAttribute("aria-expanded", "false");

  const baseText = zh
    ? `${descendants} 个子会话`
    : `${descendants} ${descendants === 1 ? "child" : "children"}`;
  const parts: string[] = [baseText];

  const baseSpan = doc.createElement("span");
  baseSpan.className = "cx-tree-summary-count";
  baseSpan.textContent = baseText;
  button.append(baseSpan);

  const appendSegment = (text: string, activity: "running" | "waiting") => {
    parts.push(text);
    const sep = doc.createElement("span");
    sep.className = "cx-tree-summary-sep";
    sep.textContent = " · ";
    const span = doc.createElement("span");
    span.className = "cx-tree-summary-activity";
    span.dataset.activity = activity;
    span.textContent = text;
    button.append(sep, span);
  };

  if (running > 0) appendSegment(zh ? `${running} 运行中` : `${running} running`, "running");
  if (waiting > 0) appendSegment(zh ? `${waiting} 待批准` : `${waiting} waiting`, "waiting");

  const label = `${parts.join(" · ")} · ${toggleLabel(descendants, false, zh)}`;
  button.title = label;
  button.setAttribute("aria-label", label);
  return button;
}

function addMark(map: Map<HTMLElement, Set<TreeMark>>, element: HTMLElement, mark: TreeMark): void {
  let set = map.get(element);
  if (!set) {
    set = new Set();
    map.set(element, set);
  }
  set.add(mark);
}

export function activate(api: DesktopExtensionApiV1): void {
  let rows: readonly DesktopSidebarRow[] = [];
  let snapshot: ThreadTreeSnapshot | undefined;
  let marks = new Map<HTMLElement, Set<TreeMark>>();
  const panels = new Map<HTMLElement, HTMLElement>();
  const nativeToggles = new Map<HTMLElement, HTMLButtonElement>();
  const expanded = new Set<string>();

  const iconObserver = createRowIconObserverManager(api, () => render());

  function toggleBranch(branchId: string, focusContainer?: ParentNode): void {
    const nextOpen = !expanded.has(branchId);
    if (nextOpen) expanded.add(branchId);
    else expanded.delete(branchId);
    render();
    if (!focusContainer) return;
    for (const button of focusContainer.querySelectorAll<HTMLButtonElement>(
      "button[data-branch]",
    )) {
      if (button.dataset.branch === branchId) {
        button.focus({ preventScroll: true });
        break;
      }
    }
  }

  function nativeToggleFor(rowElement: HTMLElement, item: HTMLElement): HTMLButtonElement {
    const existing = nativeToggles.get(rowElement);
    if (existing) return existing;
    const doc = rowElement.ownerDocument;
    const toggle = markExtensionNode(doc.createElement("button"));
    toggle.type = "button";
    toggle.className = "cx-tree-icon-toggle";
    toggle.append(createChevronSvg(doc));
    stopRowPointerPropagation(toggle, api.signal);
    toggle.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Enter" || event.key === " ") event.stopPropagation();
      },
      { signal: api.signal },
    );
    toggle.addEventListener(
      "click",
      (event) => {
        event.stopPropagation();
        event.preventDefault();
        const branchId = toggle.dataset.branch;
        if (branchId) toggleBranch(branchId, item);
      },
      { signal: api.signal },
    );
    nativeToggles.set(rowElement, toggle);
    return toggle;
  }

  function panelFor(item: HTMLElement): HTMLElement {
    const existing = panels.get(item);
    if (existing) return existing;
    const panel = markExtensionNode(item.ownerDocument.createElement("div"));
    panel.className = "cx-sidebar-tree";
    stopRowPointerPropagation(panel, api.signal);
    panel.addEventListener(
      "click",
      (event) => {
        event.stopPropagation();
        if (!(event.target instanceof Element)) return;
        const button = event.target.closest<HTMLButtonElement>("button");
        const { thread, branch } = button?.dataset ?? {};
        if (thread) {
          void openThread(api, thread);
          return;
        }
        if (branch) toggleBranch(branch, item);
      },
      { signal: api.signal },
    );
    api.dom.mount(panel, item);
    panels.set(item, panel);
    return panel;
  }

  function renderBranch(
    doc: Document,
    thread: DisplayThread,
    depth: number,
    renderHeader: boolean,
    zh: boolean,
    sidebarIcons: ReadonlyMap<string, Element>,
  ): HTMLElement {
    const hasChildren = thread.children.length > 0;
    const open = hasChildren && expanded.has(thread.id);
    const node = doc.createElement("div");
    node.className = "cx-tree-node";
    node.dataset.depth = String(depth);
    node.style.setProperty("--cx-tree-depth", String(Math.min(depth, 3)));

    if (renderHeader) {
      const row = doc.createElement("div");
      row.className = "cx-tree-row";
      row.dataset.depth = String(depth);
      row.dataset.state = thread.node.status;
      if (hasChildren) {
        row.dataset.hasChildren = "true";
        row.dataset.expanded = String(open);
      }

      const title = doc.createElement("span");
      title.className = "cx-tree-title";
      title.textContent = thread.node.title || thread.id;
      const accessible = threadAccessibleTitle(api, thread.id, thread.node, zh);
      const statusIndicator = createStatusIndicator(doc, thread.node.status);

      if (hasChildren) {
        const lead = doc.createElement("span");
        lead.className = "cx-tree-lead";
        lead.append(createThreadIcon(api, doc, thread.node.harnessId, sidebarIcons));

        const toggle = doc.createElement("button");
        toggle.type = "button";
        toggle.className = "cx-tree-row-toggle";
        toggle.dataset.branch = thread.id;
        toggle.setAttribute("aria-expanded", String(open));
        const label = toggleLabel(thread.activity.descendants, open, zh);
        toggle.title = label;
        toggle.setAttribute("aria-label", label);
        toggle.append(createChevronSvg(doc));
        lead.append(toggle);

        const main = doc.createElement("button");
        main.type = "button";
        main.className = "cx-tree-row-main";
        main.dataset.thread = thread.id;
        main.title = accessible;
        main.setAttribute("aria-label", accessible);
        main.append(title);
        if (statusIndicator) main.append(statusIndicator);

        row.append(lead, main);
      } else {
        const main = doc.createElement("button");
        main.type = "button";
        main.className = "cx-tree-row-main cx-tree-row-leaf";
        main.dataset.thread = thread.id;
        main.title = accessible;
        main.setAttribute("aria-label", accessible);
        main.append(createThreadIcon(api, doc, thread.node.harnessId, sidebarIcons), title);
        if (statusIndicator) main.append(statusIndicator);
        row.append(main);
      }

      node.append(row);
    }

    if (!hasChildren) return node;

    if (!open) {
      node.append(buildSummaryButton(doc, thread, depth, zh));
      return node;
    }

    const children = doc.createElement("div");
    children.className = "cx-tree-children";
    children.style.setProperty("--cx-tree-depth", String(Math.min(depth + 1, 3)));
    for (const child of thread.children) {
      children.append(renderBranch(doc, child, depth + 1, true, zh, sidebarIcons));
    }
    node.append(children);
    return node;
  }

  function render(): void {
    if (api.signal.aborted || !snapshot) return;
    const nextMarks = new Map<HTMLElement, Set<TreeMark>>();
    const usedPanels = new Set<HTMLElement>();
    const usedNativeToggles = new Set<HTMLElement>();
    const observedRootRows = new Set<HTMLElement>();
    const sidebarIcons = collectSidebarIcons(rows);

    const mounted = rows.map((row) => ({
      row,
      item: row.element.closest<HTMLElement>('[role="listitem"], li'),
    }));
    const counts = new Map<HTMLElement, number>();
    for (const { item } of mounted) if (item) counts.set(item, (counts.get(item) ?? 0) + 1);

    const candidates = mounted.flatMap(({ row, item }) => {
      // Don't hide an item shared with another row, e.g. a remote Host row.
      if (
        !row.isLocal ||
        !row.threadId ||
        !row.isConnected() ||
        !item?.parentElement ||
        item === row.element ||
        counts.get(item) !== 1
      ) {
        return [];
      }
      return [
        { key: { row: row.element, item }, list: item.parentElement, threadId: row.threadId },
      ];
    });

    const placements = planThreadTree(snapshot, candidates);
    const replacedOrHiddenRows = new Set<HTMLElement>();
    for (const [{ row }, placement] of placements) {
      if (placement.kind === "hidden" || placement.kind === "virtual") {
        replacedOrHiddenRows.add(row);
      }
    }

    const metricsByList = new Map<HTMLElement, ListRowMetrics>();
    let fallbackMetrics: ListRowMetrics | undefined;
    for (const { row, item } of mounted) {
      if (!row.isConnected() || !item?.parentElement || replacedOrHiddenRows.has(row.element)) {
        continue;
      }
      const list = item.parentElement;
      if (metricsByList.has(list) && fallbackMetrics) continue;
      const measured = measureRowMetrics(row.element, item);
      if (!measured) continue;
      if (!metricsByList.has(list)) metricsByList.set(list, measured);
      if (!fallbackMetrics) fallbackMetrics = measured;
    }

    for (const [{ row, item }, placement] of placements) {
      if (placement.kind === "hidden") {
        addMark(nextMarks, item, "hidden");
        continue;
      }

      const doc = item.ownerDocument;
      const zh = isZhDocument(doc);
      const open = expanded.has(placement.tree.id);
      const list = item.parentElement;
      const metrics =
        (placement.kind === "root" ? measureRowMetrics(row, item) : null) ??
        (list ? metricsByList.get(list) : undefined) ??
        fallbackMetrics ??
        DEFAULT_METRICS;

      if (placement.kind === "root") {
        observedRootRows.add(row);
        addMark(nextMarks, row, "root-row");
        const icon = findSidebarAgentIcon(row);
        if (icon) {
          addMark(nextMarks, icon, "icon-anchor");
          addMark(nextMarks, icon, open ? "icon-expanded" : "icon-collapsed");
          const toggle = nativeToggleFor(row, item);
          toggle.dataset.branch = placement.tree.id;
          toggle.setAttribute("aria-expanded", String(open));
          const label = toggleLabel(placement.tree.activity.descendants, open, zh);
          toggle.title = label;
          toggle.setAttribute("aria-label", label);
          if (toggle.parentElement !== icon) api.dom.mount(toggle, icon, "append");
          usedNativeToggles.add(row);
        }
      } else {
        addMark(nextMarks, row, "replaced");
      }

      const panel = panelFor(item);
      if (panel.parentElement !== item) api.dom.mount(panel, item);
      panel.dataset.rootKind = placement.kind;
      applyListMetrics(panel, metrics);
      panel.replaceChildren(
        renderBranch(doc, placement.tree, 0, placement.kind === "virtual", zh, sidebarIcons),
      );
      usedPanels.add(item);
    }

    for (const [element, priorMarks] of marks) {
      const next = nextMarks.get(element);
      for (const mark of priorMarks) {
        if (!next?.has(mark)) api.dom.unmark(element, mark);
      }
    }
    for (const [element, next] of nextMarks) {
      const prior = marks.get(element);
      for (const mark of next) {
        if (!prior?.has(mark)) api.dom.mark(element, mark);
      }
    }
    marks = nextMarks;

    for (const [rowElement, toggle] of nativeToggles) {
      if (usedNativeToggles.has(rowElement)) continue;
      toggle.remove();
      nativeToggles.delete(rowElement);
    }

    for (const [item, panel] of panels) {
      if (usedPanels.has(item)) continue;
      panel.remove();
      panels.delete(item);
    }

    iconObserver.sync(observedRootRows);
  }

  api.sidebar.observeRows((current) => {
    rows = current;
    render();
  });
  api.threads.watchTree((current) => {
    snapshot = current;
    render();
  });
}
