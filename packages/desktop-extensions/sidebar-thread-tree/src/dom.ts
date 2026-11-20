import type { DesktopExtensionApiV1 } from "@codexhost/shared-contracts";
import { SIDEBAR_TREE_MOTION_ATTRIBUTE, cancelSidebarThreadTreeMotion } from "./motion.js";
import {
  SIDEBAR_THREAD_TREE_MAX_INDENT_DEPTH,
  type SidebarThreadTreeActivity,
  type SidebarThreadTreeNode,
  type SidebarThreadTreeRoot,
  type SidebarThreadTreeStatus,
} from "./tree.js";

/**
 * DOM for the delegated-children tree of Codex Desktop's sidebar. Native nodes are never moved,
 * wrapped or cloned, and native elements are only decorated or hidden through `api.dom.mark` +
 * `desktop.css` so disabling the extension restores the native sidebar cleanly.
 *
 * On a native root row, a toggle is laid over its Agent icon, and the summary line or the
 * children are mounted in the row's own listitem, after Desktop's content. A tree drawn in place
 * of a member's row lives in that member's listitem, whose native content is hidden via the
 * `anchor` mark; a native row shown elsewhere in a tree has its listitem hidden via the `hidden`
 * mark.
 */

export const SIDEBAR_TREE_TOGGLE_CLASS = "cxh-tree-toggle";
export const SIDEBAR_TREE_CHEVRON_CLASS = "cxh-tree-chevron";
export const SIDEBAR_TREE_SUMMARY_LINE_CLASS = "cxh-tree-summary-line";
export const SIDEBAR_TREE_SUMMARY_CLASS = "cxh-tree-summary";
export const SIDEBAR_TREE_CHILDREN_CLASS = "cxh-tree-children";
export const SIDEBAR_TREE_BRANCH_CLASS = "cxh-tree-branch";
export const SIDEBAR_TREE_ROW_CLASS = "cxh-tree-row";
export const SIDEBAR_TREE_IDENTITY_CLASS = "cxh-tree-identity";
export const SIDEBAR_TREE_TITLE_CLASS = "cxh-tree-title";
export const SIDEBAR_TREE_STATUS_CLASS = "cxh-tree-status";
export const SIDEBAR_TREE_VIRTUAL_CLASS = "cxh-tree-virtual";

/** Each level indents children by the Web tree's 24px. */
export const SIDEBAR_TREE_INDENT_PX = 24;
/** The Agent icon codexhost puts on sidebar rows (`renderer-sidebar-agent-icons`). */
export const SIDEBAR_TREE_ICON_PX = 14;

export const SIDEBAR_TREE_TOGGLE_ATTRIBUTE = "data-codexhost-sidebar-tree-toggle";
export const SIDEBAR_TREE_EXPAND_ATTRIBUTE = "data-codexhost-sidebar-tree-expand";
export const SIDEBAR_TREE_SUMMARY_ATTRIBUTE = "data-codexhost-sidebar-tree-summary";
export const SIDEBAR_TREE_CHILDREN_ATTRIBUTE = "data-codexhost-sidebar-tree-children";
export const SIDEBAR_TREE_VIRTUAL_ATTRIBUTE = "data-codexhost-sidebar-tree-virtual";
export const SIDEBAR_TREE_NODE_ATTRIBUTE = "data-codexhost-sidebar-tree-node";
/** Identity of codexhost rows across rebuilds, for focus and for expand and collapse motion. */
export const SIDEBAR_TREE_KEY_ATTRIBUTE = "data-codexhost-sidebar-tree-key";
/** Every node this module adds carries one of these, so observers can ignore its own writes. */
export const SIDEBAR_TREE_OWNED_SELECTOR = [
  SIDEBAR_TREE_TOGGLE_ATTRIBUTE,
  SIDEBAR_TREE_SUMMARY_ATTRIBUTE,
  SIDEBAR_TREE_CHILDREN_ATTRIBUTE,
  SIDEBAR_TREE_VIRTUAL_ATTRIBUTE,
  SIDEBAR_TREE_MOTION_ATTRIBUTE,
]
  .map((name) => `[${name}]`)
  .join(", ");

export type SidebarTreeMarkName = "hidden" | "root-collapsed" | "root-expanded" | "anchor";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const PRESENTATION_ATTRIBUTE = "data-codexhost-sidebar-tree-presentation";
const NATIVE_ROW_SELECTOR = "[data-app-action-sidebar-thread-row]";
const AGENT_ICON_SELECTOR = "[data-codexhost-sidebar-agent-icon]";
const ACTIVE_ATTRIBUTE = "data-app-action-sidebar-thread-active";
const SELECTED_ATTRIBUTE = "data-app-action-sidebar-thread-selected";
/**
 * Desktop's next and previous Thread commands step through the visible rows carrying this and
 * start from the one marked `aria-current="page"`; rows codexhost draws join them in place.
 */
const CYCLE_ITEM_ATTRIBUTE = "data-sidebar-cycle-item";

export interface SidebarHarnessIcon {
  name: string;
  iconUrl?: string;
  sampled?: Element;
  signature: string;
}

/** What a tree row shows besides its place in the tree. */
export interface SidebarThreadTreeDisplay {
  title: string;
  agent: string;
  harness: SidebarHarnessIcon;
  /** The Thread the main view currently shows. */
  current: boolean;
}

export type SidebarThreadTreeNodeView = SidebarThreadTreeNode & SidebarThreadTreeDisplay;

export interface SidebarThreadTreeView extends Omit<SidebarThreadTreeRoot, "nodes"> {
  nodes: SidebarThreadTreeNodeView[];
  /** The root as a codexhost row, used when the tree stands in for another member's row. */
  root: SidebarThreadTreeDisplay;
}

export interface SidebarThreadTreeLabels {
  expand(count: number): string;
  collapse(count: number): string;
  status(status: SidebarThreadTreeStatus): string;
  children(count: number): string;
  running(count: number): string;
  pending(count: number): string;
  expandSummary(title: string, summary: string): string;
}

export interface SidebarThreadTreeHandlers {
  /** `source` is the element the user acted on, so motion can follow its list. */
  toggle(threadId: string, source: Element): void;
  /** A press on a Thread's row or on the rest of its row block. */
  open(threadId: string, source: Element): void;
}

interface TreeMetrics {
  iconLeft: number;
  titleLeft: number;
  rowHeight: number;
  radius: string;
  padEnd: number;
  gap: number;
  titleSize: string;
  titleLine: string;
  titleWeight: string;
  titleColor: string;
}

const DEFAULT_METRICS: TreeMetrics = {
  iconLeft: 32,
  titleLeft: 54,
  rowHeight: 30,
  radius: "10px",
  padEnd: 5,
  gap: 0,
  titleSize: "14px",
  titleLine: "20px",
  titleWeight: "inherit",
  titleColor: "inherit",
};

/** Lists share row metrics; a list's last measurement serves rows that are not laid out. */
const metricsByList = new WeakMap<Element, TreeMetrics>();
/** The measuring pass each list was last measured in; a pass measures a list once. */
const measuredInPass = new WeakMap<Element, number>();
let measuringPass = 0;
/** The handlers of the latest render: Desktop remounts rows, so no render may keep its own. */
const currentHandlers = new WeakMap<Element, SidebarThreadTreeHandlers>();

/**
 * Events on codexhost controls and rows that must not reach Desktop: its rows navigate on
 * press, and the row, its listitem and the list carry drag, rename and context-menu handling.
 * The ends of gestures (`pointerup`, `mouseup`) pass, so a drag started elsewhere can end here.
 */
const ISOLATED_EVENTS = [
  "pointerdown",
  "mousedown",
  "dblclick",
  "auxclick",
  "contextmenu",
  "dragstart",
];

function stopNative(event: Event): void {
  event.stopPropagation();
}

function isolate(element: HTMLElement, signal: AbortSignal): void {
  for (const type of ISOLATED_EVENTS) element.addEventListener(type, stopNative, { signal });
}

function pixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function setVariable(element: HTMLElement, name: string, value: string): void {
  if (element.style.getPropertyValue(name) !== value) element.style.setProperty(name, value);
}

function closestAttribute(target: EventTarget | null, attribute: string): HTMLElement | null {
  const view = (target as Node | null)?.ownerDocument?.defaultView;
  return view && target instanceof view.Element
    ? target.closest<HTMLElement>(`[${attribute}]`)
    : null;
}

function ownedChild(parent: Element, attribute: string): HTMLElement | null {
  for (const child of parent.children) {
    if (child.hasAttribute(attribute)) return child as HTMLElement;
  }
  return null;
}

function nativeParts(row: HTMLElement): { trigger: HTMLElement; item: HTMLElement } | null {
  const trigger = row.querySelector<HTMLElement>("[data-thread-title-trigger]");
  const item = row.closest<HTMLElement>('[role="listitem"]');
  return trigger && item ? { trigger, item } : null;
}

function markAttribute(apiId: string, name: SidebarTreeMarkName): string {
  return `data-cx-${apiId}-${name}`;
}

function setMark(
  api: DesktopExtensionApiV1,
  target: Element,
  name: SidebarTreeMarkName,
  present: boolean,
): void {
  const has = target.hasAttribute(markAttribute(api.id, name));
  if (present && !has) api.dom.mark(target, name);
  else if (!present && has) api.dom.unmark(target, name);
}

/** Whether a native row has the parts the tree is attached to. */
export function canRenderSidebarThreadTree(row: HTMLElement): boolean {
  return nativeParts(row) !== null;
}

/** Laid-out native rows of `list`, `row` itself first. */
function* laidOutRows(row: HTMLElement, list: Element | null): Generator<HTMLElement> {
  if (row.getBoundingClientRect().height > 0) yield row;
  if (!list) return;
  for (const candidate of list.querySelectorAll<HTMLElement>(NATIVE_ROW_SELECTOR)) {
    if (candidate === row || candidate.closest('[role="listitem"]')?.parentElement !== list)
      continue;
    if (candidate.getBoundingClientRect().height > 0) yield candidate;
  }
}

/** Whether Desktop shows a row's title as it shows any row: the open row has its own colour. */
function plainRow(row: HTMLElement): boolean {
  return (
    row.getAttribute(ACTIVE_ATTRIBUTE) !== "true" && row.getAttribute(SELECTED_ATTRIBUTE) !== "true"
  );
}

/**
 * Measures the rows of `item`'s list, once per measuring pass: the geometry from a laid-out row,
 * the title text from an ordinary one. A list that is not laid out reuses its last measurement.
 */
function metricsFor(apiId: string, row: HTMLElement, item: HTMLElement): TreeMetrics {
  const list = item.parentElement;
  if (list && measuredInPass.get(list) === measuringPass)
    return metricsByList.get(list) ?? DEFAULT_METRICS;
  const view = row.ownerDocument.defaultView;
  let measured: HTMLElement | null = null;
  let textRow: HTMLElement | null = null;
  if (view) {
    for (const candidate of laidOutRows(row, list)) {
      measured ??= candidate;
      if (!plainRow(candidate)) continue;
      textRow = candidate;
      break;
    }
  }
  const measuredItem = measured?.closest<HTMLElement>('[role="listitem"]');
  if (!view || !measured || !measuredItem) {
    // Nothing of the list is laid out; the pass keeps what it found instead of looking again.
    if (list) measuredInPass.set(list, measuringPass);
    return (list && metricsByList.get(list)) ?? DEFAULT_METRICS;
  }
  const itemRect = measuredItem.getBoundingClientRect();
  const rowRect = measured.getBoundingClientRect();
  const trigger = measured.querySelector<HTMLElement>("[data-thread-title-trigger]");
  const icon = measured.querySelector<HTMLElement>(AGENT_ICON_SELECTOR);
  const title = measured.querySelector<HTMLElement>("[data-thread-title]");
  const textTitle = (textRow ?? measured).querySelector<HTMLElement>("[data-thread-title]");
  const rowStyle = view.getComputedStyle(measured);
  const iconLeft =
    (icon ?? trigger)?.getBoundingClientRect().left ?? itemRect.left + DEFAULT_METRICS.iconLeft;
  const titleRect = title?.getBoundingClientRect();
  const titleStyle = textTitle ? view.getComputedStyle(textTitle) : null;
  const plainItem =
    !measuredItem.hasAttribute(markAttribute(apiId, "root-collapsed")) &&
    !measuredItem.hasAttribute(markAttribute(apiId, "root-expanded")) &&
    !measuredItem.hasAttribute(markAttribute(apiId, "anchor")) &&
    !measuredItem.querySelector(SIDEBAR_TREE_OWNED_SELECTOR);
  const metrics: TreeMetrics = {
    iconLeft: Math.round(iconLeft - itemRect.left),
    titleLeft: Math.round((titleRect?.left ?? iconLeft + SIDEBAR_TREE_ICON_PX + 8) - itemRect.left),
    rowHeight: rowRect.height,
    radius:
      pixels(rowStyle.borderTopLeftRadius) > 0
        ? rowStyle.borderTopLeftRadius
        : DEFAULT_METRICS.radius,
    padEnd: pixels(rowStyle.paddingInlineEnd) || DEFAULT_METRICS.padEnd,
    gap: plainItem
      ? Math.max(0, Math.round(itemRect.height - rowRect.height))
      : ((list && metricsByList.get(list)?.gap) ?? DEFAULT_METRICS.gap),
    titleSize: titleStyle?.fontSize || DEFAULT_METRICS.titleSize,
    titleLine: titleStyle?.lineHeight || DEFAULT_METRICS.titleLine,
    titleWeight: titleStyle?.fontWeight || DEFAULT_METRICS.titleWeight,
    titleColor: titleStyle?.color || DEFAULT_METRICS.titleColor,
  };
  if (list) {
    metricsByList.set(list, metrics);
    measuredInPass.set(list, measuringPass);
  }
  return metrics;
}

/**
 * Starts a rendering pass by measuring the lists of `rows` before anything is written, so the
 * pass reads layout once instead of once per tree.
 */
export function measureSidebarThreadTreeRows(apiId: string, rows: Iterable<HTMLElement>): void {
  measuringPass += 1;
  for (const row of rows) {
    const item = row.closest<HTMLElement>('[role="listitem"]');
    if (item) metricsFor(apiId, row, item);
  }
}

function applyMetrics(element: HTMLElement, metrics: TreeMetrics): void {
  setVariable(element, "--cxh-icon-left", `${String(metrics.iconLeft)}px`);
  setVariable(element, "--cxh-row-h", `${String(metrics.rowHeight)}px`);
  setVariable(element, "--cxh-row-radius", metrics.radius);
  setVariable(element, "--cxh-row-pad-end", `${String(metrics.padEnd)}px`);
  setVariable(element, "--cxh-gap", `${String(metrics.gap)}px`);
  setVariable(
    element,
    "--cxh-title-gap",
    `${String(Math.max(4, metrics.titleLeft - metrics.iconLeft - SIDEBAR_TREE_ICON_PX))}px`,
  );
  setVariable(element, "--cxh-title-size", metrics.titleSize);
  setVariable(element, "--cxh-title-line", metrics.titleLine);
  setVariable(element, "--cxh-title-weight", metrics.titleWeight);
  setVariable(element, "--cxh-title-color", metrics.titleColor);
  // The summary text starts under the title, as in the Web sidebar.
  setVariable(element, "--cxh-summary-start", `${String(Math.max(0, metrics.titleLeft - 8))}px`);
}

function indentOf(depth: number): string {
  return `${String(Math.min(depth, SIDEBAR_THREAD_TREE_MAX_INDENT_DEPTH) * SIDEBAR_TREE_INDENT_PX)}px`;
}

function createAgentIconElement(
  harness: SidebarHarnessIcon,
  size: number,
  ownerDocument: Document,
): Element {
  const sampled = harness.sampled;
  if (sampled) {
    const tag = sampled.tagName.toLowerCase();
    if (tag === "svg") {
      const clone = sampled.cloneNode(true) as SVGElement;
      clone.setAttribute("aria-hidden", "true");
      clone.style.width = `${String(size)}px`;
      clone.style.height = `${String(size)}px`;
      clone.style.flex = "none";
      return clone;
    }
    if (tag === "img") {
      const src = sampled.getAttribute("src");
      if (src) {
        const image = ownerDocument.createElement("img");
        image.src = src;
        image.alt = "";
        image.draggable = false;
        image.style.width = `${String(size)}px`;
        image.style.height = `${String(size)}px`;
        image.style.objectFit = "contain";
        image.style.flex = "none";
        const sampledImage = sampled as HTMLImageElement;
        if (sampledImage.style.borderRadius)
          image.style.borderRadius = sampledImage.style.borderRadius;
        if (sampledImage.style.background) image.style.background = sampledImage.style.background;
        if (sampledImage.style.padding) {
          image.style.boxSizing = "border-box";
          image.style.padding = sampledImage.style.padding;
        }
        return image;
      }
    }
  }
  if (harness.iconUrl) {
    const image = ownerDocument.createElement("img");
    image.src = harness.iconUrl;
    image.alt = "";
    image.draggable = false;
    image.style.width = `${String(size)}px`;
    image.style.height = `${String(size)}px`;
    image.style.objectFit = "contain";
    image.style.flex = "none";
    return image;
  }
  const fallback = ownerDocument.createElement("span");
  fallback.setAttribute("aria-hidden", "true");
  fallback.textContent = harness.name.slice(0, 1).toUpperCase();
  fallback.style.cssText = `display:inline-flex;align-items:center;justify-content:center;width:${String(size)}px;height:${String(size)}px;flex:none;font-size:${String(Math.round(size * 0.7))}px`;
  return fallback;
}

function chevron(ownerDocument: Document): HTMLElement {
  const element = ownerDocument.createElement("span");
  element.className = SIDEBAR_TREE_CHEVRON_CLASS;
  element.setAttribute("aria-hidden", "true");
  return element;
}

function spinner(ownerDocument: Document): SVGSVGElement {
  const svg = ownerDocument.createElementNS(SVG_NAMESPACE, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2.25");
  svg.setAttribute("stroke-linecap", "round");
  const track = ownerDocument.createElementNS(SVG_NAMESPACE, "circle");
  track.setAttribute("cx", "12");
  track.setAttribute("cy", "12");
  track.setAttribute("r", "8");
  track.setAttribute("opacity", "0.3");
  const arc = ownerDocument.createElementNS(SVG_NAMESPACE, "path");
  arc.setAttribute("d", "M12 4a8 8 0 1 1-8 8");
  svg.append(track, arc);
  return svg;
}

function statusNode(
  ownerDocument: Document,
  status: SidebarThreadTreeStatus,
  label: string,
): HTMLElement | null {
  if (status === "idle") return null;
  const node = ownerDocument.createElement("span");
  node.className = SIDEBAR_TREE_STATUS_CLASS;
  node.dataset.status = status;
  node.setAttribute("role", "img");
  node.setAttribute("aria-label", label);
  node.title = label;
  if (status === "running") node.append(spinner(ownerDocument));
  return node;
}

interface SummaryPart {
  text: string;
  activity?: "running" | "pending";
}

/** The Web sidebar's summary: the count, then running and waiting work when there is any. */
function summaryParts(
  count: number,
  activity: SidebarThreadTreeActivity,
  labels: SidebarThreadTreeLabels,
): SummaryPart[] {
  const parts: SummaryPart[] = [{ text: labels.children(count) }];
  if (activity.running > 0)
    parts.push({ text: ` · ${labels.running(activity.running)}`, activity: "running" });
  if (activity.pending > 0)
    parts.push({ text: ` · ${labels.pending(activity.pending)}`, activity: "pending" });
  return parts;
}

/** The expand button of a collapsed row's summary line. */
function summaryButton(
  ownerDocument: Document,
  node: {
    threadId: string;
    title: string;
    descendants: number;
    activity: SidebarThreadTreeActivity;
  },
  labels: SidebarThreadTreeLabels,
): HTMLElement {
  const button = ownerDocument.createElement("button");
  button.type = "button";
  button.className = SIDEBAR_TREE_SUMMARY_CLASS;
  button.setAttribute(SIDEBAR_TREE_EXPAND_ATTRIBUTE, node.threadId);
  button.setAttribute("aria-expanded", "false");
  const parts = summaryParts(node.descendants, node.activity, labels);
  button.setAttribute(
    "aria-label",
    labels.expandSummary(node.title, parts.map((part) => part.text).join("")),
  );
  for (const part of parts) {
    if (!part.activity) {
      button.append(part.text);
      continue;
    }
    const span = ownerDocument.createElement("span");
    span.dataset.activity = part.activity;
    span.textContent = part.text;
    button.append(span);
  }
  return button;
}

/** The line under a collapsed codexhost row: part of that row's block. */
function summaryLine(
  ownerDocument: Document,
  node: {
    threadId: string;
    title: string;
    descendants: number;
    activity: SidebarThreadTreeActivity;
  },
  labels: SidebarThreadTreeLabels,
): HTMLElement {
  const line = ownerDocument.createElement("div");
  line.className = SIDEBAR_TREE_SUMMARY_LINE_CLASS;
  line.setAttribute(SIDEBAR_TREE_SUMMARY_ATTRIBUTE, node.threadId);
  line.setAttribute(SIDEBAR_TREE_KEY_ATTRIBUTE, `summary:${node.threadId}`);
  line.append(summaryButton(ownerDocument, node, labels));
  return line;
}

function treeRow(
  ownerDocument: Document,
  node: {
    threadId: string;
    depth: number;
    status: SidebarThreadTreeStatus;
    descendants: number;
    expanded: boolean;
  } & SidebarThreadTreeDisplay,
  labels: SidebarThreadTreeLabels,
): HTMLElement {
  const row = ownerDocument.createElement("div");
  row.className = SIDEBAR_TREE_ROW_CLASS;
  row.setAttribute(SIDEBAR_TREE_NODE_ATTRIBUTE, node.threadId);
  row.setAttribute(SIDEBAR_TREE_KEY_ATTRIBUTE, `row:${node.threadId}`);
  row.setAttribute(CYCLE_ITEM_ATTRIBUTE, "");
  row.setAttribute("role", "treeitem");
  row.setAttribute("aria-level", String(node.depth + 1));
  row.tabIndex = 0;
  if (node.current) row.setAttribute("aria-current", "page");

  const identity = ownerDocument.createElement(node.descendants > 0 ? "button" : "span");
  identity.className = SIDEBAR_TREE_IDENTITY_CLASS;
  identity.append(createAgentIconElement(node.harness, SIDEBAR_TREE_ICON_PX, ownerDocument));
  if (node.descendants > 0) {
    const label = node.expanded
      ? labels.collapse(node.descendants)
      : labels.expand(node.descendants);
    identity.setAttribute("type", "button");
    identity.setAttribute(SIDEBAR_TREE_TOGGLE_ATTRIBUTE, node.threadId);
    identity.setAttribute("aria-expanded", String(node.expanded));
    identity.setAttribute("aria-label", label);
    identity.title = label;
    identity.append(chevron(ownerDocument));
    row.setAttribute("aria-expanded", String(node.expanded));
  } else {
    identity.setAttribute("aria-hidden", "true");
  }

  const title = ownerDocument.createElement("span");
  title.className = SIDEBAR_TREE_TITLE_CLASS;
  title.textContent = node.title;
  title.title = node.title;
  row.append(identity, title);
  const status = statusNode(ownerDocument, node.status, labels.status(node.status));
  if (status) row.append(status);
  return row;
}

function childrenGroup(ownerDocument: Document, parentDepth: number): HTMLElement {
  const group = ownerDocument.createElement("div");
  group.className = SIDEBAR_TREE_CHILDREN_CLASS;
  group.setAttribute("role", "group");
  if (parentDepth < SIDEBAR_THREAD_TREE_MAX_INDENT_DEPTH) group.setAttribute("data-guide", "");
  group.style.setProperty("--cxh-guide-indent", indentOf(parentDepth));
  return group;
}

/** A row with its summary or its children: the unit the guides hang from. */
function branch(
  ownerDocument: Document,
  node: SidebarThreadTreeNodeView,
  labels: SidebarThreadTreeLabels,
): { element: HTMLElement; children: HTMLElement | null } {
  const element = ownerDocument.createElement("div");
  element.className = SIDEBAR_TREE_BRANCH_CLASS;
  element.style.setProperty("--cxh-indent", indentOf(node.depth));
  element.append(treeRow(ownerDocument, node, labels));
  if (node.descendants === 0) return { element, children: null };
  if (!node.expanded) {
    element.append(summaryLine(ownerDocument, node, labels));
    return { element, children: null };
  }
  const children = childrenGroup(ownerDocument, node.depth);
  element.append(children);
  return { element, children };
}

/** Nests the planner's display-order nodes into branches under `group` (children of depth 0). */
function fillChildren(
  ownerDocument: Document,
  group: HTMLElement,
  nodes: readonly SidebarThreadTreeNodeView[],
  labels: SidebarThreadTreeLabels,
): void {
  const groups: HTMLElement[] = [group];
  for (const node of nodes) {
    groups.length = Math.min(groups.length, node.depth);
    const parent = groups[node.depth - 1] ?? group;
    const { element, children } = branch(ownerDocument, node, labels);
    parent.append(element);
    if (children) groups[node.depth] = children;
  }
}

function presentationOf(view: SidebarThreadTreeView, withRoot: boolean, locale: string): string {
  return JSON.stringify([
    locale,
    view.threadId,
    view.expanded,
    view.descendants,
    view.activity,
    withRoot
      ? [
          view.root.title,
          view.root.agent,
          view.root.current,
          view.status,
          view.root.harness.signature,
        ]
      : view.root.title,
    view.nodes.map((node) => [
      node.threadId,
      node.depth,
      node.title,
      node.agent,
      node.harness.signature,
      node.status,
      node.current,
      node.descendants,
      node.expanded,
      node.activity,
    ]),
  ]);
}

/** After expanding from a summary, which leaves the DOM, focus stays on its Thread's toggle. */
function focusToggleOf(scope: Element | null, threadId: string): void {
  if (!scope?.isConnected) return;
  for (const toggle of scope.querySelectorAll<HTMLElement>(`[${SIDEBAR_TREE_TOGGLE_ATTRIBUTE}]`)) {
    if (toggle.getAttribute(SIDEBAR_TREE_TOGGLE_ATTRIBUTE) !== threadId) continue;
    toggle.focus({ preventScroll: true });
    return;
  }
}

/** Delegated handling for everything codexhost draws inside one container. */
function wireContainer(container: HTMLElement, signal: AbortSignal): void {
  isolate(container, signal);
  container.addEventListener(
    "click",
    (event) => {
      const handlers = currentHandlers.get(container);
      event.stopPropagation();
      if (!handlers) return;
      const toggle = closestAttribute(event.target, SIDEBAR_TREE_TOGGLE_ATTRIBUTE);
      if (toggle) {
        event.preventDefault();
        handlers.toggle(toggle.getAttribute(SIDEBAR_TREE_TOGGLE_ATTRIBUTE) ?? "", toggle);
        return;
      }
      const expand = closestAttribute(event.target, SIDEBAR_TREE_EXPAND_ATTRIBUTE);
      if (expand) {
        const threadId = expand.getAttribute(SIDEBAR_TREE_EXPAND_ATTRIBUTE) ?? "";
        const focused = expand.ownerDocument.activeElement === expand;
        const scope = expand.closest('[role="listitem"]');
        handlers.toggle(threadId, expand);
        if (focused) focusToggleOf(scope, threadId);
        return;
      }
      // The rest of a row's block, its summary line included, acts as the row.
      const row =
        closestAttribute(event.target, SIDEBAR_TREE_NODE_ATTRIBUTE) ??
        closestAttribute(event.target, SIDEBAR_TREE_SUMMARY_ATTRIBUTE);
      const threadId =
        row?.getAttribute(SIDEBAR_TREE_NODE_ATTRIBUTE) ??
        row?.getAttribute(SIDEBAR_TREE_SUMMARY_ATTRIBUTE);
      if (row && threadId) handlers.open(threadId, row);
    },
    { signal },
  );
  container.addEventListener(
    "keydown",
    (event) => {
      const row = closestAttribute(event.target, SIDEBAR_TREE_NODE_ATTRIBUTE);
      if (!row || event.target !== row) {
        // Keys on codexhost controls stay with them; Desktop's row handles keys of its own.
        if (event.key === "Enter" || event.key === " ") event.stopPropagation();
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        currentHandlers
          .get(container)
          ?.open(row.getAttribute(SIDEBAR_TREE_NODE_ATTRIBUTE) ?? "", row);
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const rows = [...container.querySelectorAll<HTMLElement>(`[${SIDEBAR_TREE_NODE_ATTRIBUTE}]`)];
      const next = rows[rows.indexOf(row) + (event.key === "ArrowDown" ? 1 : -1)];
      if (!next) return;
      event.preventDefault();
      event.stopPropagation();
      next.focus();
    },
    { signal },
  );
}

/** Rebuilds `container` when what it shows changed; keyboard focus stays on the same control. */
function rebuild(container: HTMLElement, presentation: string, build: () => Node[]): void {
  if (container.getAttribute(PRESENTATION_ATTRIBUTE) === presentation) return;
  container.setAttribute(PRESENTATION_ATTRIBUTE, presentation);
  const ownerDocument = container.ownerDocument;
  const active = ownerDocument.activeElement;
  const focusedRow =
    active && container.contains(active)
      ? closestAttribute(active, SIDEBAR_TREE_KEY_ATTRIBUTE)
      : null;
  const focusedKey = focusedRow?.getAttribute(SIDEBAR_TREE_KEY_ATTRIBUTE) ?? null;
  const toggleFocused =
    focusedKey !== null && closestAttribute(active, SIDEBAR_TREE_TOGGLE_ATTRIBUTE) !== null;
  // A summary button outside any row, such as a native root's, is found again by its Thread.
  const focusedExpand =
    active && container.contains(active)
      ? (closestAttribute(active, SIDEBAR_TREE_EXPAND_ATTRIBUTE)?.getAttribute(
          SIDEBAR_TREE_EXPAND_ATTRIBUTE,
        ) ?? null)
      : null;
  container.replaceChildren(...build());
  if (focusedKey === null) {
    if (focusedExpand === null) return;
    for (const expand of container.querySelectorAll<HTMLElement>(
      `[${SIDEBAR_TREE_EXPAND_ATTRIBUTE}]`,
    )) {
      if (expand.getAttribute(SIDEBAR_TREE_EXPAND_ATTRIBUTE) !== focusedExpand) continue;
      expand.focus({ preventScroll: true });
      return;
    }
    return;
  }
  for (const candidate of container.querySelectorAll<HTMLElement>(
    `[${SIDEBAR_TREE_KEY_ATTRIBUTE}]`,
  )) {
    if (candidate.getAttribute(SIDEBAR_TREE_KEY_ATTRIBUTE) !== focusedKey) continue;
    const control = toggleFocused
      ? candidate.querySelector<HTMLElement>(`[${SIDEBAR_TREE_TOGGLE_ATTRIBUTE}]`)
      : candidate.tabIndex >= 0
        ? candidate
        : candidate.querySelector<HTMLElement>("button");
    (control ?? candidate).focus({ preventScroll: true });
    return;
  }
}

function createToggle(ownerDocument: Document, signal: AbortSignal): HTMLElement {
  const toggle = ownerDocument.createElement("button");
  toggle.type = "button";
  toggle.className = SIDEBAR_TREE_TOGGLE_CLASS;
  toggle.append(chevron(ownerDocument));
  isolate(toggle, signal);
  toggle.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Enter" || event.key === " ") event.stopPropagation();
    },
    { signal },
  );
  toggle.addEventListener(
    "click",
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      const control = event.currentTarget as HTMLElement;
      const threadId = control.getAttribute(SIDEBAR_TREE_TOGGLE_ATTRIBUTE);
      if (threadId) currentHandlers.get(control)?.toggle(threadId, control);
    },
    { signal },
  );
  return toggle;
}

/** Toggle over the Agent icon of a native row; the icon and title never move. */
function placeToggle(
  api: DesktopExtensionApiV1,
  row: HTMLElement,
  trigger: HTMLElement,
  view: SidebarThreadTreeView,
  labels: SidebarThreadTreeLabels,
  handlers: SidebarThreadTreeHandlers,
): void {
  const ownerDocument = row.ownerDocument;
  const toggle =
    row.querySelector<HTMLElement>(`[${SIDEBAR_TREE_TOGGLE_ATTRIBUTE}]`) ??
    createToggle(ownerDocument, api.signal);
  currentHandlers.set(toggle, handlers);
  const label = view.expanded ? labels.collapse(view.descendants) : labels.expand(view.descendants);
  if (toggle.getAttribute(SIDEBAR_TREE_TOGGLE_ATTRIBUTE) !== view.threadId)
    toggle.setAttribute(SIDEBAR_TREE_TOGGLE_ATTRIBUTE, view.threadId);
  if (toggle.getAttribute("aria-expanded") !== String(view.expanded))
    toggle.setAttribute("aria-expanded", String(view.expanded));
  if (toggle.getAttribute("aria-label") !== label) {
    toggle.setAttribute("aria-label", label);
    toggle.title = label;
  }
  const icon = trigger.querySelector<HTMLElement>(AGENT_ICON_SELECTOR);
  const parentStyle = icon?.parentElement
    ? ownerDocument.defaultView?.getComputedStyle(icon.parentElement)
    : undefined;
  const centredFlexRow =
    parentStyle !== undefined &&
    parentStyle.display.includes("flex") &&
    !parentStyle.flexDirection.startsWith("column") &&
    parentStyle.alignItems === "center";
  const leading =
    icon !== null &&
    (icon.previousElementSibling === null || icon.previousElementSibling === toggle);
  if (icon && centredFlexRow && leading) {
    // Out of flow, the first item of a centred flex row sits where the icon starts.
    if (icon.previousElementSibling !== toggle) api.dom.mount(toggle, icon, "before");
    toggle.style.removeProperty("left");
    toggle.style.removeProperty("top");
    if (toggle.getAttribute("style") === "") toggle.removeAttribute("style");
    return;
  }
  // Otherwise the row, which Desktop positions, places it over the icon or the title start.
  if (trigger.firstElementChild !== toggle) api.dom.mount(toggle, trigger, "prepend");
  const rowRect = row.getBoundingClientRect();
  if (rowRect.height === 0) return;
  const target = (icon ?? trigger).getBoundingClientRect();
  setVariable(toggle, "left", `${String(Math.round(target.left - rowRect.left))}px`);
  setVariable(toggle, "top", `${String(Math.round((rowRect.height - 20) / 2))}px`);
}

/** Shows `view` on a native root row: the icon toggle and the summary or the children. */
export function renderSidebarThreadTreeRoot(
  api: DesktopExtensionApiV1,
  row: HTMLElement,
  view: SidebarThreadTreeView,
  labels: SidebarThreadTreeLabels,
  handlers: SidebarThreadTreeHandlers,
  locale: string,
): boolean {
  const parts = nativeParts(row);
  if (!parts || view.descendants === 0) {
    clearSidebarThreadTreeRow(api, row);
    return false;
  }
  const { trigger, item } = parts;
  const ownerDocument = row.ownerDocument;
  clearVirtual(api, item);
  const metrics = metricsFor(api.id, row, item);
  placeToggle(api, row, trigger, view, labels, handlers);
  setMark(api, item, "root-expanded", view.expanded);
  setMark(api, item, "root-collapsed", !view.expanded);

  const attribute = view.expanded
    ? SIDEBAR_TREE_CHILDREN_ATTRIBUTE
    : SIDEBAR_TREE_SUMMARY_ATTRIBUTE;
  ownedChild(
    item,
    view.expanded ? SIDEBAR_TREE_SUMMARY_ATTRIBUTE : SIDEBAR_TREE_CHILDREN_ATTRIBUTE,
  )?.remove();
  let container = ownedChild(item, attribute);
  if (!container) {
    container = ownerDocument.createElement("div");
    if (view.expanded) {
      container.className = SIDEBAR_TREE_CHILDREN_CLASS;
      container.setAttribute("role", "group");
      container.setAttribute("data-guide", "");
      container.style.setProperty("--cxh-guide-indent", "0px");
    } else {
      container.className = SIDEBAR_TREE_SUMMARY_LINE_CLASS;
    }
    wireContainer(container, api.signal);
  }
  if (container.getAttribute(attribute) !== view.threadId)
    container.setAttribute(attribute, view.threadId);
  currentHandlers.set(container, handlers);
  applyMetrics(container, metrics);
  // React may re-insert the row's own content after this container; keep codexhost content last.
  if (item.lastElementChild !== container) api.dom.mount(container, item, "append");
  rebuild(container, presentationOf(view, false, locale), () => {
    if (!view.expanded) {
      return [
        summaryButton(
          ownerDocument,
          {
            threadId: view.threadId,
            title: view.root.title,
            descendants: view.descendants,
            activity: view.activity,
          },
          labels,
        ),
      ];
    }
    const holder = ownerDocument.createElement("div");
    fillChildren(ownerDocument, holder, view.nodes, labels);
    return [...holder.childNodes];
  });
  return true;
}

/** Shows `view` in place of a member's row, whose native content is hidden meanwhile. */
export function renderSidebarThreadTreeVirtual(
  api: DesktopExtensionApiV1,
  row: HTMLElement,
  view: SidebarThreadTreeView,
  labels: SidebarThreadTreeLabels,
  handlers: SidebarThreadTreeHandlers,
  locale: string,
): boolean {
  const parts = nativeParts(row);
  if (!parts || view.descendants === 0) {
    clearSidebarThreadTreeRow(api, row);
    return false;
  }
  const { item } = parts;
  const ownerDocument = row.ownerDocument;
  clearNativeRoot(api, row, item);
  // Measure before the native content is hidden; afterwards the list's measurement is reused.
  const metrics = metricsFor(api.id, row, item);
  setMark(api, item, "anchor", true);
  let container = ownedChild(item, SIDEBAR_TREE_VIRTUAL_ATTRIBUTE);
  if (!container) {
    container = ownerDocument.createElement("div");
    container.className = SIDEBAR_TREE_VIRTUAL_CLASS;
    // Its root row is a treeitem, which needs a group or tree around it.
    container.setAttribute("role", "group");
    wireContainer(container, api.signal);
  }
  if (container.getAttribute(SIDEBAR_TREE_VIRTUAL_ATTRIBUTE) !== view.threadId)
    container.setAttribute(SIDEBAR_TREE_VIRTUAL_ATTRIBUTE, view.threadId);
  currentHandlers.set(container, handlers);
  applyMetrics(container, metrics);
  if (item.firstElementChild !== container) api.dom.mount(container, item, "prepend");
  rebuild(container, presentationOf(view, true, locale), () => {
    const { element, children } = branch(
      ownerDocument,
      {
        threadId: view.threadId,
        depth: 0,
        status: view.status,
        descendants: view.descendants,
        expanded: view.expanded,
        rollup: view.rollup,
        activity: view.activity,
        ...view.root,
      },
      labels,
    );
    if (children) fillChildren(ownerDocument, children, view.nodes, labels);
    return [element];
  });
  return true;
}

function clearNativeRoot(api: DesktopExtensionApiV1, row: HTMLElement, item: HTMLElement): void {
  row.querySelector(`[${SIDEBAR_TREE_TOGGLE_ATTRIBUTE}]`)?.remove();
  ownedChild(item, SIDEBAR_TREE_SUMMARY_ATTRIBUTE)?.remove();
  ownedChild(item, SIDEBAR_TREE_CHILDREN_ATTRIBUTE)?.remove();
  setMark(api, item, "root-collapsed", false);
  setMark(api, item, "root-expanded", false);
}

function clearVirtual(api: DesktopExtensionApiV1, item: HTMLElement): void {
  ownedChild(item, SIDEBAR_TREE_VIRTUAL_ATTRIBUTE)?.remove();
  setMark(api, item, "anchor", false);
}

/** Removes everything this module added to one native row and its listitem. */
export function clearSidebarThreadTreeRow(api: DesktopExtensionApiV1, row: HTMLElement): void {
  const item = row.closest<HTMLElement>('[role="listitem"]');
  if (!item) {
    row.querySelector(`[${SIDEBAR_TREE_TOGGLE_ATTRIBUTE}]`)?.remove();
    return;
  }
  clearNativeRoot(api, row, item);
  clearVirtual(api, item);
}

/** Hides or restores the listitem of a native row whose Thread is shown in a tree above it. */
export function setSidebarThreadTreeRowHidden(
  api: DesktopExtensionApiV1,
  row: HTMLElement,
  hidden: boolean,
): void {
  const item = row.closest<HTMLElement>('[role="listitem"]');
  if (!item) return;
  setMark(api, item, "hidden", hidden);
}

/** Cancels active motion when tearing down. Mounted DOM and marks are reclaimed by the host. */
export function clearSidebarThreadTree(api: DesktopExtensionApiV1, root: ParentNode): void {
  cancelSidebarThreadTreeMotion();
  if (!api.signal.aborted) {
    const marks: SidebarTreeMarkName[] = ["hidden", "root-collapsed", "root-expanded", "anchor"];
    for (const name of marks) {
      const attr = markAttribute(api.id, name);
      for (const item of root.querySelectorAll<HTMLElement>(`[${attr}]`)) {
        api.dom.unmark(item, name);
      }
    }
  }
  for (const node of root.querySelectorAll(SIDEBAR_TREE_OWNED_SELECTOR)) node.remove();
}
