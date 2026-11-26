import { resolveLocalizedExtensionText } from "@codexhost/shared-contracts";
import { resolveRendererSettingsLocale } from "./settings/localization.js";

const NAVIGATION_RAIL_SELECTOR = "nav[data-app-navigation-rail]";
export const DESKTOP_EXTENSION_RAIL_STYLE_ATTRIBUTE = "data-codexhost-extension-rail-style";
export const DESKTOP_EXTENSION_RAIL_ITEM_ATTRIBUTE = "data-codexhost-extension-rail-item";
export const DESKTOP_EXTENSION_RAIL_CONTROL_ATTRIBUTE = "data-codexhost-extension-rail-control";
export const DESKTOP_EXTENSION_RAIL_ICON_ONLY_ATTRIBUTE = "data-codexhost-extension-rail-icon-only";

const RAIL_INTERACTIVE_SELECTOR = 'button, a, [role="button"], [role="link"]';
const RAIL_ICON_SELECTOR = "svg, img, canvas, picture";
const SKIPPED_TEXT_TAGS = new Set(["svg", "style", "script", "template"]);

/**
 * Constrain Desktop extension entries mounted inside Codex Desktop's left
 * navigation rail to the rail's 36px icon-only button geometry so extension
 * labels cannot widen the rail.
 */
const RAIL_EXTENSION_STYLE = `
nav[data-app-navigation-rail] [${DESKTOP_EXTENSION_RAIL_ITEM_ATTRIBUTE}]:not([${DESKTOP_EXTENSION_RAIL_CONTROL_ATTRIBUTE}]):not([hidden]) {
  display: flex !important;
  flex-direction: column !important;
  align-items: center !important;
  justify-content: center !important;
  flex: 0 0 auto !important;
  width: 36px !important;
  min-width: 36px !important;
  max-width: 36px !important;
  padding: 0 !important;
  margin-inline: auto !important;
  box-sizing: border-box !important;
  overflow: hidden !important;
}

nav[data-app-navigation-rail] [${DESKTOP_EXTENSION_RAIL_ITEM_ATTRIBUTE}]:not([${DESKTOP_EXTENSION_RAIL_CONTROL_ATTRIBUTE}]):has([${DESKTOP_EXTENSION_RAIL_CONTROL_ATTRIBUTE}]) > :not([${DESKTOP_EXTENSION_RAIL_CONTROL_ATTRIBUTE}]):not(:has([${DESKTOP_EXTENSION_RAIL_CONTROL_ATTRIBUTE}])) {
  display: none !important;
}

nav[data-app-navigation-rail] [${DESKTOP_EXTENSION_RAIL_ITEM_ATTRIBUTE}]:not([${DESKTOP_EXTENSION_RAIL_CONTROL_ATTRIBUTE}]):not(:has([${DESKTOP_EXTENSION_RAIL_CONTROL_ATTRIBUTE}])):not([hidden]) {
  height: 36px !important;
  min-height: 36px !important;
  max-height: 36px !important;
}

nav[data-app-navigation-rail] [${DESKTOP_EXTENSION_RAIL_CONTROL_ATTRIBUTE}]:not([hidden]) {
  position: relative !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  flex: 0 0 auto !important;
  width: 36px !important;
  min-width: 36px !important;
  max-width: 36px !important;
  height: 36px !important;
  min-height: 36px !important;
  max-height: 36px !important;
  padding: 0 !important;
  margin-inline: auto !important;
  gap: 0 !important;
  border-radius: 12.5px !important;
  corner-shape: superellipse(1.5) !important;
  box-sizing: border-box !important;
  overflow: hidden !important;
  text-align: center !important;
  white-space: nowrap !important;
  outline-offset: 2px !important;
  color: var(--color-text-secondary-ghost, light-dark(rgba(26, 28, 31, 0.5), rgba(255, 255, 255, 0.55))) !important;
}

nav[data-app-navigation-rail] [${DESKTOP_EXTENSION_RAIL_CONTROL_ATTRIBUTE}]:not([hidden]):is(:hover, :focus-visible, [aria-current="page"], [aria-pressed="true"], [data-selected]) {
  color: var(--color-text-secondary-ghost-hover, light-dark(#1a1c1f, #ffffff)) !important;
  background: var(--color-background-secondary-ghost-hover, light-dark(rgba(26, 28, 31, 0.05), rgba(255, 255, 255, 0.08))) !important;
}

nav[data-app-navigation-rail] [${DESKTOP_EXTENSION_RAIL_ICON_ONLY_ATTRIBUTE}]:not([hidden]) {
  font-size: 0 !important;
  line-height: 0 !important;
}

nav[data-app-navigation-rail] [${DESKTOP_EXTENSION_RAIL_ICON_ONLY_ATTRIBUTE}] > :not(${RAIL_ICON_SELECTOR}):not(:has(${RAIL_ICON_SELECTOR})) {
  display: none !important;
}

nav[data-app-navigation-rail] [${DESKTOP_EXTENSION_RAIL_ICON_ONLY_ATTRIBUTE}] > :not(${RAIL_ICON_SELECTOR}):has(${RAIL_ICON_SELECTOR}):not([hidden]) {
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  flex: none !important;
  width: auto !important;
  min-width: 0 !important;
  max-width: 22px !important;
  height: auto !important;
  max-height: 22px !important;
  margin: 0 !important;
  padding: 0 !important;
  gap: 0 !important;
}

nav[data-app-navigation-rail] [${DESKTOP_EXTENSION_RAIL_ICON_ONLY_ATTRIBUTE}] > :not(${RAIL_ICON_SELECTOR}):has(${RAIL_ICON_SELECTOR}) > :not(${RAIL_ICON_SELECTOR}):not(:has(${RAIL_ICON_SELECTOR})) {
  display: none !important;
}

nav[data-app-navigation-rail] [${DESKTOP_EXTENSION_RAIL_ICON_ONLY_ATTRIBUTE}] :is(${RAIL_ICON_SELECTOR}) {
  flex: none !important;
  font-size: 16px !important;
  max-width: 22px !important;
  max-height: 22px !important;
  margin: 0 !important;
}

nav[data-app-navigation-rail] [${DESKTOP_EXTENSION_RAIL_ICON_ONLY_ATTRIBUTE}] img {
  object-fit: contain !important;
}
`;

export type DesktopExtensionRailName =
  string | { readonly en: string; readonly "zh-CN": string } | undefined;

interface ManagedAttributeState {
  appliedTitle: string | null;
  appliedAriaLabel: string | null;
}

interface TrackedRailItem {
  readonly extensionId: string;
  readonly node: Element;
  fallbackName: DesktopExtensionRailName;
  readonly controls: Map<Element, ManagedAttributeState>;
  readonly rootState: ManagedAttributeState;
  observer?: MutationObserver;
}

export interface DesktopExtensionRailPresentation {
  syncMount(extensionId: string, node: Element, fallbackName?: DesktopExtensionRailName): void;
  releaseExtension(extensionId: string): void;
  dispose(): void;
}

function isHiddenInline(element: Element): boolean {
  if (element.hasAttribute("hidden")) return true;
  const style = (element as Partial<HTMLElement>).style;
  return style?.display === "none";
}

function isHiddenWithin(element: Element, boundary: Element): boolean {
  let current: Element | null = element;
  while (current && current !== boundary) {
    if (isHiddenInline(current)) return true;
    current = current.parentElement;
  }
  return false;
}

function hasVisibleIcon(container: Element): boolean {
  for (const candidate of container.querySelectorAll(RAIL_ICON_SELECTOR)) {
    if (!isHiddenWithin(candidate, container)) return true;
  }
  return false;
}

function collectVisibleText(node: Node, skip?: Element): string[] {
  const chunks: string[] = [];
  const visit = (current: Node): void => {
    if (current === skip) return;
    if (current.nodeType === 3) {
      const text = current.textContent?.replace(/\s+/gu, " ").trim();
      if (text) chunks.push(text);
      return;
    }
    if (current.nodeType !== 1) return;
    const element = current as Element;
    const tag = element.tagName.toLowerCase();
    if (SKIPPED_TEXT_TAGS.has(tag)) return;
    if (isHiddenInline(element)) return;
    if (element.getAttribute("aria-hidden") === "true") return;
    if (element.getAttribute("role") === "tooltip") return;
    for (const child of element.childNodes) visit(child);
  };
  visit(node);
  return chunks;
}

function extractGraphicLabel(container: Element): string {
  for (const image of container.querySelectorAll("img[alt]")) {
    if (isHiddenWithin(image, container)) continue;
    const alt = image.getAttribute("alt")?.replace(/\s+/gu, " ").trim();
    if (alt) return alt;
  }
  for (const title of container.querySelectorAll("svg > title")) {
    const svg = title.parentElement;
    if (svg && isHiddenWithin(svg, container)) continue;
    const text = title.textContent?.replace(/\s+/gu, " ").trim();
    if (text) return text;
  }
  return "";
}

function resolveFallbackLabel(name: DesktopExtensionRailName, document: Document): string {
  if (!name) return "";
  const languages = [
    document.documentElement?.lang,
    ...(document.defaultView?.navigator?.languages ?? []),
    document.defaultView?.navigator?.language,
  ].filter((entry): entry is string => Boolean(entry));
  const locale = resolveRendererSettingsLocale(languages);
  return resolveLocalizedExtensionText(name, locale).replace(/\s+/gu, " ").trim();
}

function findTopLevelControls(root: Element): Element[] {
  if (root.matches(RAIL_INTERACTIVE_SELECTOR)) return [root];
  return [...root.querySelectorAll(RAIL_INTERACTIVE_SELECTOR)].filter((element) => {
    const enclosing = element.parentElement?.closest(RAIL_INTERACTIVE_SELECTOR);
    return !enclosing || !root.contains(enclosing);
  });
}

function setAttributeIfChanged(element: Element, name: string, value: string): void {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function syncManagedAttribute(
  element: Element,
  attribute: "title" | "aria-label",
  nextValue: string,
  state: ManagedAttributeState,
  slot: "appliedTitle" | "appliedAriaLabel",
): void {
  const current = element.getAttribute(attribute);
  const applied = state[slot];
  const ownedByHost = current === null || current === "" || current === applied;
  if (!ownedByHost) {
    state[slot] = null;
    return;
  }
  if (nextValue) {
    if (current !== nextValue) element.setAttribute(attribute, nextValue);
    state[slot] = nextValue;
  } else if (applied !== null && current === applied) {
    element.removeAttribute(attribute);
    state[slot] = null;
  }
}

function restoreManagedAttributes(element: Element, state: ManagedAttributeState): void {
  if (state.appliedTitle !== null && element.getAttribute("title") === state.appliedTitle) {
    element.removeAttribute("title");
  }
  if (
    state.appliedAriaLabel !== null &&
    element.getAttribute("aria-label") === state.appliedAriaLabel
  ) {
    element.removeAttribute("aria-label");
  }
  state.appliedTitle = null;
  state.appliedAriaLabel = null;
}

function restoreControl(control: Element, state: ManagedAttributeState): void {
  control.removeAttribute(DESKTOP_EXTENSION_RAIL_CONTROL_ATTRIBUTE);
  control.removeAttribute(DESKTOP_EXTENSION_RAIL_ICON_ONLY_ATTRIBUTE);
  restoreManagedAttributes(control, state);
}

export function createDesktopExtensionRailPresentation(
  document: Document,
): DesktopExtensionRailPresentation {
  const trackedByNode = new Map<Element, TrackedRailItem>();
  const nodesByExtension = new Map<string, Set<Element>>();
  let styleElement: HTMLStyleElement | null = null;

  const ensureStyle = (): void => {
    if (styleElement?.isConnected) return;
    const existing = document.querySelector<HTMLStyleElement>(
      `style[${DESKTOP_EXTENSION_RAIL_STYLE_ATTRIBUTE}]`,
    );
    if (existing) {
      styleElement = existing;
      return;
    }
    const parent = document.head ?? document.documentElement;
    if (!parent) return;
    const style = document.createElement("style");
    style.setAttribute(DESKTOP_EXTENSION_RAIL_STYLE_ATTRIBUTE, "");
    style.textContent = RAIL_EXTENSION_STYLE;
    parent.append(style);
    styleElement = style;
  };

  const cleanupStyleIfUnused = (): void => {
    if (trackedByNode.size > 0) return;
    styleElement?.remove();
    styleElement = null;
  };

  const untrackNode = (node: Element): void => {
    const record = trackedByNode.get(node);
    if (!record) return;
    record.observer?.disconnect();
    trackedByNode.delete(node);
    const bucket = nodesByExtension.get(record.extensionId);
    bucket?.delete(node);
    if (bucket && bucket.size === 0) nodesByExtension.delete(record.extensionId);

    for (const [control, state] of record.controls) {
      restoreControl(control, state);
    }
    record.controls.clear();
    node.removeAttribute(DESKTOP_EXTENSION_RAIL_ITEM_ATTRIBUTE);
    node.removeAttribute(DESKTOP_EXTENSION_RAIL_ICON_ONLY_ATTRIBUTE);
    restoreManagedAttributes(node, record.rootState);
    cleanupStyleIfUnused();
  };

  const syncRecord = (record: TrackedRailItem): void => {
    const { node } = record;
    if (node.isConnected && !node.closest(NAVIGATION_RAIL_SELECTOR)) {
      untrackNode(node);
      return;
    }
    ensureStyle();
    setAttributeIfChanged(node, DESKTOP_EXTENSION_RAIL_ITEM_ATTRIBUTE, record.extensionId);

    const controls = findTopLevelControls(node);
    const nextControlSet = new Set(controls);
    for (const [existing, state] of [...record.controls]) {
      if (!nextControlSet.has(existing)) {
        restoreControl(existing, state);
        record.controls.delete(existing);
      }
    }

    const fallback = resolveFallbackLabel(record.fallbackName, document);

    if (controls.length === 0) {
      const iconOnly = hasVisibleIcon(node);
      if (iconOnly) setAttributeIfChanged(node, DESKTOP_EXTENSION_RAIL_ICON_ONLY_ATTRIBUTE, "true");
      else node.removeAttribute(DESKTOP_EXTENSION_RAIL_ICON_ONLY_ATTRIBUTE);
      const label = collectVisibleText(node).join(" ") || extractGraphicLabel(node) || fallback;
      syncManagedAttribute(node, "title", label, record.rootState, "appliedTitle");
      return;
    }

    if (!nextControlSet.has(node)) {
      node.removeAttribute(DESKTOP_EXTENSION_RAIL_ICON_ONLY_ATTRIBUTE);
      restoreManagedAttributes(node, record.rootState);
    }

    for (const control of controls) {
      let state = record.controls.get(control);
      if (!state) {
        state = { appliedTitle: null, appliedAriaLabel: null };
        record.controls.set(control, state);
      }
      setAttributeIfChanged(control, DESKTOP_EXTENSION_RAIL_CONTROL_ATTRIBUTE, "");
      const iconOnly = hasVisibleIcon(control);
      if (iconOnly) {
        setAttributeIfChanged(control, DESKTOP_EXTENSION_RAIL_ICON_ONLY_ATTRIBUTE, "true");
      } else {
        control.removeAttribute(DESKTOP_EXTENSION_RAIL_ICON_ONLY_ATTRIBUTE);
      }

      const ownText = collectVisibleText(control).join(" ");
      const wrapperSiblingText =
        !ownText && controls.length === 1 && control !== node
          ? collectVisibleText(node, control).join(" ")
          : "";
      const label = ownText || wrapperSiblingText || extractGraphicLabel(control) || fallback;
      syncManagedAttribute(control, "title", label, state, "appliedTitle");
      syncManagedAttribute(control, "aria-label", label, state, "appliedAriaLabel");
    }
  };

  return {
    syncMount(extensionId, node, fallbackName) {
      const inRail = Boolean(node.closest(NAVIGATION_RAIL_SELECTOR));
      if (!inRail) {
        untrackNode(node);
        return;
      }

      // If mounted inside an already-tracked rail item of this extension, sync the root instead.
      const trackedAncestor = node.parentElement?.closest(
        `[${DESKTOP_EXTENSION_RAIL_ITEM_ATTRIBUTE}]`,
      );
      if (trackedAncestor && trackedAncestor !== node) {
        const ancestorRecord = trackedByNode.get(trackedAncestor);
        if (ancestorRecord) {
          untrackNode(node);
          syncRecord(ancestorRecord);
          return;
        }
      }

      let record = trackedByNode.get(node);
      if (record && record.extensionId !== extensionId) {
        untrackNode(node);
        record = undefined;
      }

      if (!record) {
        record = {
          extensionId,
          node,
          fallbackName,
          controls: new Map(),
          rootState: { appliedTitle: null, appliedAriaLabel: null },
        };
        trackedByNode.set(node, record);
        let bucket = nodesByExtension.get(extensionId);
        if (!bucket) {
          bucket = new Set();
          nodesByExtension.set(extensionId, bucket);
        }
        bucket.add(node);

        const MutationObserverCtor =
          document.defaultView?.MutationObserver ?? globalThis.MutationObserver;
        if (MutationObserverCtor) {
          const tracked = record;
          const observer = new MutationObserverCtor(() => {
            if (trackedByNode.get(node) !== tracked) return;
            syncRecord(tracked);
          });
          observer.observe(node, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ["hidden", "aria-hidden", "aria-label", "title", "role", "style"],
          });
          record.observer = observer;
        }
      } else if (fallbackName !== undefined) {
        record.fallbackName = fallbackName;
      }

      syncRecord(record);
    },

    releaseExtension(extensionId) {
      const bucket = nodesByExtension.get(extensionId);
      if (!bucket) return;
      for (const node of [...bucket]) untrackNode(node);
    },

    dispose() {
      for (const node of [...trackedByNode.keys()]) untrackNode(node);
      styleElement?.remove();
      styleElement = null;
    },
  };
}
