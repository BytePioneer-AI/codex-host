import { createRendererSettingsIcon } from "./icons.js";

export const SETTINGS_TRIGGER_ATTRIBUTE = "data-codexhost-settings-trigger";
export const SETTINGS_HEADER_SURFACE_SELECTOR =
  '[data-testid="app-shell-header-context-menu-surface"]';

export interface RendererSettingsTriggerControl {
  root: HTMLElement;
  button: HTMLButtonElement;
  dispose(): void;
}

export interface RendererSettingsBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

export interface RendererSettingsHeaderSlotCandidate<T> {
  value: T;
  bounds: RendererSettingsBounds;
  visibleButtonCount: number;
}

export interface RendererSettingsHeaderTriggerControl {
  readonly root: HTMLElement | null;
  refresh(): boolean;
  dispose(): void;
}

interface RendererSettingsHeaderInsertionPoint {
  parent: HTMLElement;
  before: ChildNode | null;
}

interface MeasuredHeaderSlot {
  slot: HTMLElement;
}

function measuredBounds(element: Element): RendererSettingsBounds {
  const bounds = element.getBoundingClientRect();
  return {
    left: bounds.left,
    right: bounds.right,
    top: bounds.top,
    bottom: bounds.bottom,
    width: bounds.width,
    height: bounds.height,
  };
}

function isVisibleButton(button: HTMLButtonElement): boolean {
  const bounds = button.getBoundingClientRect();
  return bounds.width > 0 && bounds.height > 0;
}

export function selectRendererSettingsHeaderSlot<T>(
  header: RendererSettingsBounds,
  candidates: readonly RendererSettingsHeaderSlotCandidate<T>[],
): T | null {
  const midpoint = header.left + header.width / 2;
  const maximumWidth = Math.min(240, header.width / 2);
  const eligible = candidates.filter(
    ({ bounds, visibleButtonCount }) =>
      visibleButtonCount > 0 &&
      bounds.width > 0 &&
      bounds.height > 0 &&
      bounds.width <= maximumWidth &&
      bounds.left >= midpoint &&
      bounds.right <= header.right + 1 &&
      bounds.top >= header.top - 1 &&
      bounds.bottom <= header.bottom + 1,
  );
  eligible.sort(
    (left, right) =>
      Math.abs(header.right - left.bounds.right) - Math.abs(header.right - right.bounds.right) ||
      right.bounds.left - left.bounds.left,
  );
  return eligible[0]?.value ?? null;
}

function settingsHeaderCandidates(ownerDocument: Document): HTMLElement[] {
  const candidates: HTMLElement[] = [];
  const semanticHeader = ownerDocument
    .querySelector(SETTINGS_HEADER_SURFACE_SELECTOR)
    ?.closest<HTMLElement>("header");
  if (semanticHeader) candidates.push(semanticHeader);
  for (const candidate of ownerDocument.querySelectorAll<HTMLElement>(".app-header-tint, header")) {
    if (!candidates.includes(candidate)) candidates.push(candidate);
  }
  return candidates;
}

function findRendererSettingsHeaderInsertionPoint(
  ownerDocument: Document,
): RendererSettingsHeaderInsertionPoint | null {
  for (const header of settingsHeaderCandidates(ownerDocument)) {
    const headerBounds = measuredBounds(header);
    if (headerBounds.width <= 0 || headerBounds.height <= 0) continue;
    const measuredSlots = [...header.children]
      .filter((child): child is HTMLElement => child instanceof HTMLElement)
      .map((slot): RendererSettingsHeaderSlotCandidate<MeasuredHeaderSlot> => {
        const buttons = [...slot.querySelectorAll<HTMLButtonElement>("button")].filter(
          isVisibleButton,
        );
        return {
          value: { slot },
          bounds: measuredBounds(slot),
          visibleButtonCount: buttons.length,
        };
      });
    const selected = selectRendererSettingsHeaderSlot(headerBounds, measuredSlots);
    if (selected) return { parent: header, before: selected.slot };
  }
  return null;
}

export function mountRendererSettingsTrigger(
  triggerId: string,
  available: boolean,
  onOpen: (opener: HTMLButtonElement) => void,
  ownerDocument: Document = document,
): RendererSettingsTriggerControl {
  const root = ownerDocument.createElement("div");
  root.setAttribute(SETTINGS_TRIGGER_ATTRIBUTE, triggerId);
  root.style.display = "inline-flex";
  root.style.alignItems = "center";
  root.style.justifyContent = "center";
  root.style.alignSelf = "center";
  root.style.flex = "0 0 auto";
  root.style.width = "28px";
  root.style.height = "28px";
  root.style.marginRight = "6px";
  root.style.color = "inherit";
  root.style.pointerEvents = "auto";
  root.style.setProperty("-webkit-app-region", "no-drag");

  const button = ownerDocument.createElement("button");
  button.type = "button";
  button.disabled = !available;
  button.setAttribute("aria-label", "Open codexhost settings");
  button.setAttribute("aria-haspopup", "dialog");
  button.title = available ? "codexhost settings" : "codexhost settings unavailable";
  button.style.display = "inline-flex";
  button.style.alignItems = "center";
  button.style.justifyContent = "center";
  button.style.width = "28px";
  button.style.height = "28px";
  button.style.padding = "0";
  button.style.border = "0";
  button.style.borderRadius = "8px";
  button.style.background = "transparent";
  button.style.color = "inherit";
  button.style.cursor = available ? "pointer" : "not-allowed";
  button.style.opacity = available ? "1" : "0.5";
  button.style.outlineOffset = "2px";
  button.style.setProperty("-webkit-app-region", "no-drag");
  button.append(createRendererSettingsIcon("settings", 17));

  const onPointerEnter = (): void => {
    if (!button.disabled) button.style.background = "rgba(127, 127, 127, 0.16)";
  };
  const onPointerLeave = (): void => {
    button.style.background = "transparent";
  };
  const onClick = (event: MouseEvent): void => {
    event.stopPropagation();
    if (!button.disabled) onOpen(button);
  };
  button.addEventListener("pointerenter", onPointerEnter);
  button.addEventListener("pointerleave", onPointerLeave);
  button.addEventListener("click", onClick);
  root.append(button);

  return {
    root,
    button,
    dispose() {
      button.removeEventListener("pointerenter", onPointerEnter);
      button.removeEventListener("pointerleave", onPointerLeave);
      button.removeEventListener("click", onClick);
      root.remove();
    },
  };
}

export function installRendererSettingsHeaderTrigger(options: {
  available: boolean;
  onOpen(opener: HTMLButtonElement): void;
  ownerDocument?: Document;
}): RendererSettingsHeaderTriggerControl {
  const ownerDocument = options.ownerDocument ?? document;
  let trigger: RendererSettingsTriggerControl | null = null;
  let disposed = false;

  const refresh = (): boolean => {
    if (disposed) return false;
    if (trigger?.root.isConnected) return true;
    trigger?.dispose();
    trigger = null;
    for (const duplicate of ownerDocument.querySelectorAll(`[${SETTINGS_TRIGGER_ATTRIBUTE}]`)) {
      duplicate.remove();
    }
    const insertionPoint = findRendererSettingsHeaderInsertionPoint(ownerDocument);
    if (!insertionPoint) return false;
    trigger = mountRendererSettingsTrigger(
      "application-header",
      options.available,
      options.onOpen,
      ownerDocument,
    );
    insertionPoint.parent.insertBefore(trigger.root, insertionPoint.before);
    return true;
  };

  refresh();
  return {
    get root() {
      return trigger?.root ?? null;
    },
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      trigger?.dispose();
      trigger = null;
    },
  };
}
