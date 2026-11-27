export const SUMMARY_PANEL_SELECTOR = '[data-summary-panel-variant="summary"]';
export const EMPTY_SUMMARY_PANEL_ATTRIBUTE = "data-codexhost-empty-summary-panel";
export const SUMMARY_PANEL_GUARD_STYLE_ATTRIBUTE = "data-codexhost-summary-panel-guard";

const EXCLUDED_SUMMARY_PANEL_ANCESTOR_SELECTOR =
  '[data-pip-obstacle="thread-summary-panel-popover"], [data-radix-popper-content-wrapper], [role="dialog"]';

const VISIBLE_CONTENT_TAGS = new Set([
  "A",
  "BUTTON",
  "CANVAS",
  "HR",
  "IFRAME",
  "IMG",
  "INPUT",
  "SELECT",
  "SVG",
  "TEXTAREA",
  "VIDEO",
]);

const VISIBLE_CONTENT_ROLES = new Set(["progressbar", "status"]);

function isDomElement(value: unknown): value is Element {
  return typeof Element !== "undefined" && value instanceof Element;
}

function isDocumentNode(value: unknown): value is Document {
  return typeof Document !== "undefined" && value instanceof Document;
}

export function isExcludedSummaryPanel(panel: Element): boolean {
  return panel.closest(EXCLUDED_SUMMARY_PANEL_ANCESTOR_SELECTOR) !== null;
}

function isElementHidden(element: Element): boolean {
  if (element.hasAttribute("hidden")) return true;
  if (element.getAttribute("aria-hidden") === "true") return true;
  if (element.classList?.contains("hidden")) return true;
  const inlineStyle = (element as Partial<HTMLElement>).style;
  if (inlineStyle?.display === "none" || inlineStyle?.visibility === "hidden") return true;
  const computed = element.ownerDocument?.defaultView?.getComputedStyle?.(element);
  if (computed && (computed.display === "none" || computed.visibility === "hidden")) return true;
  return false;
}

function isVisibleContentElement(element: Element): boolean {
  if (VISIBLE_CONTENT_TAGS.has(element.tagName.toUpperCase())) return true;
  const role = element.getAttribute("role");
  return role !== null && VISIBLE_CONTENT_ROLES.has(role);
}

function subtreeHasVisibleContent(container: Node): boolean {
  for (let child = container.firstChild; child !== null; child = child.nextSibling) {
    if (child.nodeType === 3) {
      if ((child.nodeValue ?? "").trim().length > 0) return true;
      continue;
    }
    if (child.nodeType !== 1 || !isDomElement(child)) continue;
    if (isElementHidden(child)) continue;
    if (isVisibleContentElement(child)) return true;
    if (subtreeHasVisibleContent(child)) return true;
  }
  return false;
}

export function hasVisibleSummaryPanelContent(panel: Element): boolean {
  return subtreeHasVisibleContent(panel);
}

export function reconcileSummaryPanel(panel: Element): boolean {
  if (isExcludedSummaryPanel(panel) || hasVisibleSummaryPanelContent(panel)) {
    if (panel.hasAttribute(EMPTY_SUMMARY_PANEL_ATTRIBUTE)) {
      panel.removeAttribute(EMPTY_SUMMARY_PANEL_ATTRIBUTE);
    }
    return false;
  }
  if (panel.getAttribute(EMPTY_SUMMARY_PANEL_ATTRIBUTE) !== "true") {
    panel.setAttribute(EMPTY_SUMMARY_PANEL_ATTRIBUTE, "true");
  }
  return true;
}

function collectSummaryPanels(root: ParentNode): Element[] {
  const panels: Element[] = [];
  if (isDomElement(root) && root.matches(SUMMARY_PANEL_SELECTOR)) {
    panels.push(root);
  }
  if (typeof root.querySelectorAll === "function") {
    for (const element of root.querySelectorAll(SUMMARY_PANEL_SELECTOR)) {
      panels.push(element);
    }
  }
  return panels;
}

export function reconcileSummaryPanels(root: ParentNode): number {
  let hiddenCount = 0;
  for (const panel of collectSummaryPanels(root)) {
    if (reconcileSummaryPanel(panel)) hiddenCount += 1;
  }
  return hiddenCount;
}

function installGuardStyle(ownerDocument: Document): HTMLStyleElement | null {
  if (typeof ownerDocument.createElement !== "function") return null;
  ownerDocument.querySelector(`style[${SUMMARY_PANEL_GUARD_STYLE_ATTRIBUTE}]`)?.remove();
  const style = ownerDocument.createElement("style");
  style.setAttribute(SUMMARY_PANEL_GUARD_STYLE_ATTRIBUTE, "true");
  style.textContent = `
    ${SUMMARY_PANEL_SELECTOR}[${EMPTY_SUMMARY_PANEL_ATTRIBUTE}="true"] {
      display: none !important;
    }
  `;
  (ownerDocument.head ?? ownerDocument.documentElement)?.append?.(style);
  return style;
}

function nodeMatchesOrContainsSummaryPanel(node: Node): boolean {
  if (!isDomElement(node)) return false;
  if (node.matches(SUMMARY_PANEL_SELECTOR)) return true;
  return node.childElementCount > 0 && node.querySelector(SUMMARY_PANEL_SELECTOR) !== null;
}

function targetBelongsToObservedPanel(target: Node, observedPanels: ReadonlySet<Element>): boolean {
  if (observedPanels.size === 0) return false;
  for (const panel of observedPanels) {
    if (panel === target || panel.contains(target)) return true;
  }
  return false;
}

function mutationMayAffectSummaryPanels(
  mutations: readonly MutationRecord[],
  observedPanels: ReadonlySet<Element>,
): boolean {
  for (const mutation of mutations) {
    if (mutation.type === "attributes") return true;
    if (mutation.type !== "childList") continue;
    if (targetBelongsToObservedPanel(mutation.target, observedPanels)) return true;
    for (const node of mutation.addedNodes) {
      if (nodeMatchesOrContainsSummaryPanel(node)) return true;
    }
    for (const node of mutation.removedNodes) {
      if (!isDomElement(node)) continue;
      for (const panel of observedPanels) {
        if (node === panel || node.contains(panel)) return true;
      }
      if (nodeMatchesOrContainsSummaryPanel(node)) return true;
    }
  }
  return false;
}

export function installRendererSummaryPanelGuard(root?: ParentNode): {
  refresh(): void;
  dispose(): void;
} {
  const owner =
    root ??
    (typeof document !== "undefined" && typeof Element !== "undefined" ? document : undefined);
  if (
    !owner ||
    typeof MutationObserver === "undefined" ||
    typeof Element === "undefined" ||
    typeof document === "undefined"
  ) {
    return { refresh() {}, dispose() {} };
  }
  const ownerDocument = isDocumentNode(owner) ? owner : ((owner as Node).ownerDocument ?? document);
  const style = installGuardStyle(ownerDocument);
  const observedPanels = new Set<Element>();
  let disposed = false;

  const panelObserverOptions: MutationObserverInit = {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["style", "hidden", "class", "aria-hidden"],
    characterData: true,
  };

  const panelObserver = new MutationObserver(() => {
    if (disposed) return;
    sync();
  });

  const sync = (): void => {
    if (disposed) return;
    const currentPanels = collectSummaryPanels(owner);
    const currentSet = new Set(currentPanels);
    let pruned = false;
    for (const previous of [...observedPanels]) {
      if (!currentSet.has(previous) || !previous.isConnected) {
        previous.removeAttribute(EMPTY_SUMMARY_PANEL_ATTRIBUTE);
        observedPanels.delete(previous);
        pruned = true;
      }
    }
    if (pruned) {
      panelObserver.disconnect();
      for (const panel of observedPanels) {
        panelObserver.observe(panel, panelObserverOptions);
      }
    }
    for (const panel of currentPanels) {
      if (!observedPanels.has(panel)) {
        observedPanels.add(panel);
        panelObserver.observe(panel, panelObserverOptions);
      }
      reconcileSummaryPanel(panel);
    }
  };

  const rootObserver = new MutationObserver((mutations) => {
    if (disposed || !mutationMayAffectSummaryPanels(mutations, observedPanels)) return;
    sync();
  });
  rootObserver.observe(owner, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-summary-panel-variant"],
  });

  sync();

  return {
    refresh() {
      sync();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      rootObserver.disconnect();
      panelObserver.disconnect();
      for (const panel of observedPanels) {
        panel.removeAttribute(EMPTY_SUMMARY_PANEL_ATTRIBUTE);
      }
      observedPanels.clear();
      if (isDomElement(owner) || isDocumentNode(owner)) {
        if (isDomElement(owner)) owner.removeAttribute(EMPTY_SUMMARY_PANEL_ATTRIBUTE);
        for (const panel of owner.querySelectorAll(`[${EMPTY_SUMMARY_PANEL_ATTRIBUTE}]`)) {
          panel.removeAttribute(EMPTY_SUMMARY_PANEL_ATTRIBUTE);
        }
      }
      style?.remove();
    },
  };
}
