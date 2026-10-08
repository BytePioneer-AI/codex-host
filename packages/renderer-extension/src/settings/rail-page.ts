import { SETTINGS_TRIGGER_ATTRIBUTE } from "./trigger.js";

const NAVIGATION_RAIL_SELECTOR = "nav[data-app-navigation-rail]";
const RAIL_DESTINATION_SELECTOR = "[data-sidebar-destination]";
const RAIL_OPEN_ATTRIBUTE = "data-codexhost-settings-open";
const RAIL_STYLE_ATTRIBUTE = "data-codexhost-settings-rail-style";
const RAIL_EDGE_PROPERTY = "--codexhost-settings-rail-right";
const RAIL_TOP_PROPERTY = "--codexhost-settings-rail-top";

/**
 * Native rail buttons draw their selected state with `[data-selected]::before`
 * and the hover text color. While the settings page covers the content area,
 * that highlight is hidden with scoped CSS instead of editing React-owned
 * attributes, so native reconciliation never races the Host.
 */
const RAIL_STYLE = `
nav[data-app-navigation-rail][${RAIL_OPEN_ATTRIBUTE}] ${RAIL_DESTINATION_SELECTOR}[data-selected]:not(:hover) {
  color: var(--button-text-color) !important;
}
nav[data-app-navigation-rail][${RAIL_OPEN_ATTRIBUTE}] ${RAIL_DESTINATION_SELECTOR}[data-selected]:not(:hover)::before {
  opacity: 0 !important;
}
`;

export interface RendererSettingsRailPageOptions {
  ownerDocument: Document;
  /** Positioned surface that covers the native content area beside the rail. */
  surface: HTMLElement;
  /** Native navigation took over; the page must yield without restoring focus. */
  onNavigateAway(): void;
}

export interface RendererSettingsRailPage {
  dispose(): void;
}

function findRail(ownerDocument: Document): HTMLElement | null {
  const rail = ownerDocument.querySelector<HTMLElement>(NAVIGATION_RAIL_SELECTOR);
  if (!rail) return null;
  const bounds = rail.getBoundingClientRect();
  return bounds.width > 0 && bounds.height > 0 ? rail : null;
}

function currentDestinations(rail: HTMLElement | null): string {
  if (!rail) return "";
  return [...rail.querySelectorAll(`${RAIL_DESTINATION_SELECTOR}[aria-current="page"]`)]
    .map((element) => element.getAttribute("data-sidebar-destination") ?? "")
    .join("\n");
}

/**
 * Presents the settings surface as a page beside the native navigation rail
 * for as long as it stays attached. It only reads the rail's geometry and
 * current destination; Codex's own content tree is never touched.
 */
export function attachRendererSettingsRailPage(
  options: RendererSettingsRailPageOptions,
): RendererSettingsRailPage {
  const { ownerDocument, surface, onNavigateAway } = options;
  const ownerWindow = ownerDocument.defaultView;
  let rail = findRail(ownerDocument);
  const initialDestinations = currentDestinations(rail);
  const initialLocation = ownerWindow?.location.href ?? "";
  let disposed = false;

  const style = ownerDocument.createElement("style");
  style.setAttribute(RAIL_STYLE_ATTRIBUTE, "");
  style.textContent = RAIL_STYLE;
  (ownerDocument.head ?? ownerDocument.documentElement).append(style);

  const place = (): void => {
    const bounds = rail?.getBoundingClientRect();
    surface.style.setProperty(RAIL_EDGE_PROPERTY, `${Math.max(0, bounds?.right ?? 0)}px`);
    surface.style.setProperty(RAIL_TOP_PROPERTY, `${Math.max(0, bounds?.top ?? 0)}px`);
  };

  const navigateAway = (): void => {
    if (disposed) return;
    onNavigateAway();
  };

  const checkNavigation = (): void => {
    if (disposed) return;
    const nextRail = findRail(ownerDocument);
    if (nextRail !== rail) {
      rail?.removeAttribute(RAIL_OPEN_ATTRIBUTE);
      rail = nextRail;
      bindRail();
    }
    if (
      currentDestinations(rail) !== initialDestinations ||
      (ownerWindow?.location.href ?? "") !== initialLocation
    ) {
      navigateAway();
    }
  };

  const onDocumentClick = (event: MouseEvent): void => {
    if (!(event.target instanceof Element)) return;
    if (!event.target.closest(NAVIGATION_RAIL_SELECTOR)) return;
    if (event.target.closest(`[${SETTINGS_TRIGGER_ATTRIBUTE}]`)) return;
    const destination = event.target.closest(RAIL_DESTINATION_SELECTOR);
    if (!destination) return;
    // Settings only covers the native page. Reselecting an already-current Home
    // would reset its conversation to `/`; dismiss the cover instead. If the
    // native location or selection is unclear/changed, leave navigation alone.
    // This document capture handler assumes native navigation runs later (currently
    // during bubbling). Recheck this ordering if Desktop adds earlier capture listeners.
    if (
      event.button === 0 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      destination.getAttribute("data-sidebar-destination") === "builtin:home" &&
      destination.getAttribute("aria-current") === "page" &&
      initialDestinations === "builtin:home" &&
      destination.closest(NAVIGATION_RAIL_SELECTOR) === rail &&
      currentDestinations(rail) === initialDestinations &&
      ownerWindow?.location.href === initialLocation
    ) {
      event.preventDefault();
      event.stopPropagation();
    }
    navigateAway();
  };

  const MutationObserverCtor = ownerWindow?.MutationObserver;
  const ResizeObserverCtor = ownerWindow?.ResizeObserver;
  const railMutations = MutationObserverCtor ? new MutationObserverCtor(checkNavigation) : null;
  const railResize = ResizeObserverCtor ? new ResizeObserverCtor(place) : null;
  // The rail may be replaced by React; watching the body's direct children is
  // cheap and lets a remounted rail be picked up again.
  const bodyMutations = MutationObserverCtor ? new MutationObserverCtor(checkNavigation) : null;

  function bindRail(): void {
    railMutations?.disconnect();
    railResize?.disconnect();
    if (rail) {
      rail.setAttribute(RAIL_OPEN_ATTRIBUTE, "");
      railMutations?.observe(rail, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["aria-current"],
      });
      railResize?.observe(rail);
    }
    place();
  }

  bindRail();
  if (ownerDocument.body) bodyMutations?.observe(ownerDocument.body, { childList: true });
  ownerDocument.addEventListener("click", onDocumentClick, true);
  ownerWindow?.addEventListener("resize", place);
  ownerWindow?.addEventListener("popstate", checkNavigation);
  ownerWindow?.addEventListener("hashchange", checkNavigation);

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      railMutations?.disconnect();
      railResize?.disconnect();
      bodyMutations?.disconnect();
      ownerDocument.removeEventListener("click", onDocumentClick, true);
      ownerWindow?.removeEventListener("resize", place);
      ownerWindow?.removeEventListener("popstate", checkNavigation);
      ownerWindow?.removeEventListener("hashchange", checkNavigation);
      rail?.removeAttribute(RAIL_OPEN_ATTRIBUTE);
      style.remove();
    },
  };
}
