import { createRendererSettingsBrandGlyph } from "./icons.js";
import {
  DEFAULT_RENDERER_SETTINGS_MESSAGES,
  type RendererSettingsMessages,
} from "./localization.js";

export const SETTINGS_TRIGGER_ATTRIBUTE = "data-codexhost-settings-trigger";
const SETTINGS_RAIL_SELECTOR = "nav[data-app-navigation-rail]";
const SETTINGS_RAIL_DESTINATION_SELECTOR = "[data-sidebar-destination]";
const UPDATE_ACCENT = "#3b82f6";
const RAIL_ICON_COLOR = "var(--color-text-secondary-ghost, rgba(26, 28, 31, 0.5))";
const RAIL_ICON_HOVER_COLOR = "var(--color-text-secondary-ghost-hover, #1a1c1f)";
const RAIL_ICON_HOVER_BACKGROUND =
  "var(--color-background-secondary-ghost-hover, rgba(26, 28, 31, 0.05))";

export interface RendererSettingsTriggerControl {
  root: HTMLElement;
  button: HTMLButtonElement;
  setUpdateAvailable(available: boolean): void;
  dispose(): void;
}

export interface RendererSettingsRailTriggerControl {
  readonly root: HTMLElement | null;
  refresh(): boolean;
  setUpdateAvailable(available: boolean): void;
  dispose(): void;
}

interface RendererSettingsRailInsertionPoint {
  parent: HTMLElement;
  before: ChildNode | null;
}

export interface RendererSettingsContractInspection {
  railCount: number;
  visibleRailCount: number;
  insertionPointCount: number;
}

function isVisible(element: Element): boolean {
  const bounds = element.getBoundingClientRect();
  return bounds.width > 0 && bounds.height > 0;
}

function hasDestination(element: Element): boolean {
  return (
    element.matches(SETTINGS_RAIL_DESTINATION_SELECTOR) ||
    element.querySelector(SETTINGS_RAIL_DESTINATION_SELECTOR) !== null
  );
}

/**
 * The rail's top column lists native destinations and ends with the More
 * button, which has no destination. The trigger goes directly above More.
 */
function findRailInsertionPoint(rail: HTMLElement): RendererSettingsRailInsertionPoint | null {
  const column = [...rail.children].find(hasDestination) as HTMLElement | undefined;
  if (!column) return null;
  const last = [...column.children]
    .filter((child) => !child.hasAttribute(SETTINGS_TRIGGER_ATTRIBUTE))
    .at(-1);
  return { parent: column, before: last && !hasDestination(last) ? last : null };
}

export function inspectRendererSettingsContract(
  ownerDocument: Document = document,
): RendererSettingsContractInspection {
  const rails = [...ownerDocument.querySelectorAll<HTMLElement>(SETTINGS_RAIL_SELECTOR)];
  const visibleRails = rails.filter(isVisible);
  return {
    railCount: rails.length,
    visibleRailCount: visibleRails.length,
    insertionPointCount: visibleRails.filter((rail) => findRailInsertionPoint(rail) !== null)
      .length,
  };
}

function findRendererSettingsRailInsertionPoint(
  ownerDocument: Document,
): RendererSettingsRailInsertionPoint | null {
  const rail = ownerDocument.querySelector<HTMLElement>(SETTINGS_RAIL_SELECTOR);
  return rail && isVisible(rail) ? findRailInsertionPoint(rail) : null;
}

export function mountRendererSettingsTrigger(
  triggerId: string,
  available: boolean,
  onOpen: (opener: HTMLButtonElement, pageId?: "updates") => void,
  ownerDocument: Document = document,
  messages: RendererSettingsMessages = DEFAULT_RENDERER_SETTINGS_MESSAGES,
): RendererSettingsTriggerControl {
  const root = ownerDocument.createElement("div");
  root.setAttribute(SETTINGS_TRIGGER_ATTRIBUTE, triggerId);
  root.style.display = "flex";
  root.style.alignItems = "center";
  root.style.justifyContent = "center";
  root.style.flex = "0 0 auto";

  // Matches the rail's native 36px ghost icon buttons and their color tokens.
  const button = ownerDocument.createElement("button");
  button.type = "button";
  button.disabled = !available;
  button.setAttribute("aria-label", messages.openSettings);
  button.setAttribute("aria-haspopup", "dialog");
  button.style.position = "relative";
  button.style.display = "inline-flex";
  button.style.alignItems = "center";
  button.style.justifyContent = "center";
  button.style.width = "36px";
  button.style.height = "36px";
  button.style.padding = "0";
  button.style.border = "0";
  button.style.borderRadius = "12.5px";
  button.style.setProperty("corner-shape", "superellipse(1.5)");
  button.style.background = "transparent";
  button.style.color = RAIL_ICON_COLOR;
  button.style.cursor = available ? "pointer" : "not-allowed";
  button.style.opacity = available ? "1" : "0.5";
  button.style.outlineOffset = "2px";
  button.append(createRendererSettingsBrandGlyph(20));

  const updateBadge = ownerDocument.createElement("span");
  updateBadge.setAttribute("aria-hidden", "true");
  updateBadge.style.position = "absolute";
  updateBadge.style.top = "5px";
  updateBadge.style.right = "5px";
  updateBadge.style.width = "8px";
  updateBadge.style.height = "8px";
  updateBadge.style.borderRadius = "50%";
  // One accent that reads on both light and dark rails; the tooltip carries the wording.
  updateBadge.style.background = UPDATE_ACCENT;
  updateBadge.style.display = "none";
  button.append(updateBadge);

  let updateAvailable = false;
  const renderTitle = (): void => {
    button.title = !available
      ? messages.settingsUnavailableTitle
      : updateAvailable
        ? `${messages.settingsButtonTitle} · ${messages.updateAvailable}`
        : messages.settingsButtonTitle;
  };
  renderTitle();

  const onPointerEnter = (): void => {
    if (button.disabled) return;
    button.style.background = RAIL_ICON_HOVER_BACKGROUND;
    button.style.color = RAIL_ICON_HOVER_COLOR;
  };
  const onPointerLeave = (): void => {
    button.style.background = "transparent";
    button.style.color = RAIL_ICON_COLOR;
  };
  const onClick = (event: MouseEvent): void => {
    event.stopPropagation();
    if (button.disabled) return;
    if (updateAvailable) onOpen(button, "updates");
    else onOpen(button);
  };
  button.addEventListener("pointerenter", onPointerEnter);
  button.addEventListener("pointerleave", onPointerLeave);
  button.addEventListener("click", onClick);
  root.append(button);

  return {
    root,
    button,
    setUpdateAvailable(next) {
      updateAvailable = next;
      root.toggleAttribute("data-update-available", next);
      updateBadge.style.display = next ? "block" : "none";
      renderTitle();
    },
    dispose() {
      button.removeEventListener("pointerenter", onPointerEnter);
      button.removeEventListener("pointerleave", onPointerLeave);
      button.removeEventListener("click", onClick);
      root.remove();
    },
  };
}

export function installRendererSettingsRailTrigger(options: {
  available: boolean;
  onOpen(opener: HTMLButtonElement, pageId?: "updates"): void;
  messages?: RendererSettingsMessages;
  ownerDocument?: Document;
}): RendererSettingsRailTriggerControl {
  const ownerDocument = options.ownerDocument ?? document;
  let trigger: RendererSettingsTriggerControl | null = null;
  let updateAvailable = false;
  let disposed = false;

  const refresh = (): boolean => {
    if (disposed) return false;
    const insertionPoint = findRendererSettingsRailInsertionPoint(ownerDocument);
    if (!insertionPoint) {
      trigger?.root.remove();
      return false;
    }
    if (!trigger) {
      for (const duplicate of ownerDocument.querySelectorAll(`[${SETTINGS_TRIGGER_ATTRIBUTE}]`)) {
        duplicate.remove();
      }
      trigger = mountRendererSettingsTrigger(
        "navigation-rail",
        options.available,
        options.onOpen,
        ownerDocument,
        options.messages,
      );
      trigger.setUpdateAvailable(updateAvailable);
    }
    if (
      trigger.root.parentElement !== insertionPoint.parent ||
      trigger.root.nextSibling !== insertionPoint.before
    ) {
      insertionPoint.parent.insertBefore(trigger.root, insertionPoint.before);
    }
    return true;
  };

  refresh();
  return {
    get root() {
      return trigger?.root ?? null;
    },
    refresh,
    setUpdateAvailable(available) {
      updateAvailable = available;
      trigger?.setUpdateAvailable(available);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      trigger?.dispose();
      trigger = null;
    },
  };
}
