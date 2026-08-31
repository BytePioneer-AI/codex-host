import type { HarnessCommandDescriptor } from "@codexhost/shared-contracts";

import {
  rendererHarnessCommandPresentation,
  rendererHarnessMessages,
  type RendererHarnessMessages,
} from "./renderer-harness-localization.js";
import type { RendererSettingsLocale } from "./settings/localization.js";

const CONTROL_ATTRIBUTE = "data-codexhost-harness-command-control";
const MENU_ATTRIBUTE = "data-codexhost-harness-command-menu";
const MENU_WIDTH = 320;
const VIEWPORT_MARGIN = 8;
const MENU_GAP = 8;
const SVG_NS = "http://www.w3.org/2000/svg";
const COMMAND_ICON_PATHS = [
  "M409.6 377.6h204.8a32 32 0 0 1 32 32v204.8a32 32 0 0 1-32 32H409.6a32 32 0 0 1-32-32V409.6a32 32 0 0 1 32-32z m172.8 64h-140.8v140.8h140.8z",
  "M332.8 800a108.8 108.8 0 0 1 0-217.6h76.8a32 32 0 0 1 32 32v76.8a108.928 108.928 0 0 1-108.8 108.8z m0-153.6a44.8 44.8 0 1 0 44.8 44.8v-44.8zM409.6 441.6H332.8a108.8 108.8 0 1 1 108.8-108.8v76.8a32 32 0 0 1-32 32z m-76.8-153.6a44.8 44.8 0 0 0 0 89.6h44.8V332.8A44.842667 44.842667 0 0 0 332.8 288zM691.2 441.6h-76.8a32 32 0 0 1-32-32V332.8a108.8 108.8 0 1 1 108.8 108.8z m-44.8-64h44.8a44.8 44.8 0 1 0-44.8-44.8zM691.2 800a108.928 108.928 0 0 1-108.8-108.8v-76.8a32 32 0 0 1 32-32h76.8a108.8 108.8 0 0 1 0 217.6z m-44.8-153.6v44.8a44.8 44.8 0 1 0 44.8-44.8z",
  "M640 970.666667H384c-118.186667 0-198.272-25.002667-251.946667-78.72S53.333333 758.186667 53.333333 640V384c0-118.186667 25.002667-198.272 78.72-251.946667S265.813333 53.333333 384 53.333333h256c118.186667 0 198.272 25.002667 251.946667 78.72S970.666667 265.813333 970.666667 384v256c0 118.186667-25.002667 198.272-78.72 251.946667S758.186667 970.666667 640 970.666667z m-256-853.333334c-100.096 0-165.802667 19.2-206.72 59.946667S117.333333 283.904 117.333333 384v256c0 100.096 19.072 165.802667 59.946667 206.72S283.904 906.666667 384 906.666667h256c100.096 0 165.802667-19.072 206.72-59.946667S906.666667 740.096 906.666667 640V384c0-100.096-19.072-165.802667-59.946667-206.72S740.096 117.333333 640 117.333333z",
];

function commandIcon(ownerDocument: Document): SVGSVGElement {
  const svg = ownerDocument.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 1024 1024");
  svg.setAttribute("width", "15");
  svg.setAttribute("height", "15");
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("aria-hidden", "true");
  for (const path of COMMAND_ICON_PATHS) {
    const element = ownerDocument.createElementNS(SVG_NS, "path");
    element.setAttribute("d", path);
    svg.append(element);
  }
  return svg;
}

export interface RendererHarnessCommandControl {
  root: HTMLElement;
  trigger: HTMLButtonElement;
  menu: HTMLElement;
  setCommands(commands: readonly HarnessCommandDescriptor[]): void;
  setExecuting(commandId: string | null): void;
  setLocale(locale: RendererSettingsLocale): void;
  placeBefore(reference: Element | null): boolean;
  close(): void;
  dispose(): void;
}

function menuItem(
  ownerDocument: Document,
  command: HarnessCommandDescriptor,
  locale: RendererSettingsLocale,
  messages: RendererHarnessMessages,
  onSelect: () => void,
): HTMLButtonElement {
  const presentation = rendererHarnessCommandPresentation(command, locale);
  const item = ownerDocument.createElement("button");
  item.type = "button";
  item.setAttribute("role", "menuitem");
  item.setAttribute("data-command-id", command.id);
  item.setAttribute("aria-label", `${command.invocation} ${presentation.label}`);
  item.style.display = "flex";
  item.style.alignItems = "center";
  item.style.width = "100%";
  item.style.minHeight = "38px";
  item.style.gap = "8px";
  item.style.padding = "6px 8px";
  item.style.border = "0";
  item.style.borderRadius = "6px";
  item.style.background = "transparent";
  item.style.color = "inherit";
  item.style.textAlign = "left";
  item.style.cursor = "pointer";

  const updateHighlight = (active: boolean): void => {
    item.style.background = active ? "rgba(127, 127, 127, 0.12)" : "transparent";
  };
  item.addEventListener("pointerenter", () => updateHighlight(true));
  item.addEventListener("pointerleave", () => updateHighlight(false));
  item.addEventListener("focus", () => updateHighlight(true));
  item.addEventListener("blur", () => updateHighlight(false));
  item.addEventListener("click", onSelect);

  const copy = ownerDocument.createElement("span");
  copy.style.display = "flex";
  copy.style.flexDirection = "column";
  copy.style.minWidth = "0";
  copy.style.flex = "1 1 auto";

  const title = ownerDocument.createElement("span");
  title.textContent = command.invocation;
  title.style.font = "600 13px/18px system-ui, sans-serif";
  title.style.whiteSpace = "nowrap";

  const description = ownerDocument.createElement("span");
  description.textContent = presentation.description;
  description.style.overflow = "hidden";
  description.style.color = "rgba(127, 127, 127, 0.9)";
  description.style.font = "400 11px/16px system-ui, sans-serif";
  description.style.textOverflow = "ellipsis";
  description.style.whiteSpace = "nowrap";

  const hint = ownerDocument.createElement("span");
  hint.textContent = command.argumentMode === "text" ? messages.textArgument : "↵";
  hint.style.flex = "0 0 auto";
  hint.style.color = "rgba(127, 127, 127, 0.75)";
  hint.style.font = "400 11px/16px ui-monospace, SFMono-Regular, Menlo, monospace";

  copy.append(title, description);
  item.append(copy, hint);
  return item;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}

function setButtonClass(button: HTMLButtonElement): void {
  button.style.display = "inline-flex";
  button.style.alignItems = "center";
  button.style.justifyContent = "center";
  button.style.gap = "0";
  button.style.width = "28px";
  button.style.height = "28px";
  button.style.padding = "0";
  button.style.border = "0";
  button.style.borderRadius = "8px";
  button.style.background = "transparent";
  button.style.color = "inherit";
  button.style.cursor = "pointer";
  button.style.whiteSpace = "nowrap";
}

export function mountRendererHarnessCommandControl(
  parent: Element,
  insertBefore: Element | null,
  onCommandSelected: (command: HarnessCommandDescriptor) => void,
  initialLocale: RendererSettingsLocale = "en",
): RendererHarnessCommandControl {
  const ownerDocument = parent.ownerDocument;
  let locale = initialLocale;
  let messages = rendererHarnessMessages(locale);
  const root = ownerDocument.createElement("div");
  root.setAttribute(CONTROL_ATTRIBUTE, "true");
  root.style.display = "inline-flex";
  root.style.alignItems = "center";
  root.style.minWidth = "0";

  const trigger = ownerDocument.createElement("button");
  trigger.type = "button";
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-label", messages.harnessCommands);
  trigger.title = messages.harnessCommands;
  setButtonClass(trigger);
  trigger.append(commandIcon(ownerDocument));
  root.append(trigger);

  const menu = ownerDocument.createElement("div");
  menu.setAttribute(MENU_ATTRIBUTE, "true");
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", messages.harnessCommands);
  menu.hidden = true;
  menu.style.position = "fixed";
  menu.style.inset = "auto";
  menu.style.zIndex = "2147483647";
  menu.style.width = `${MENU_WIDTH}px`;
  menu.style.maxWidth = `calc(100vw - ${VIEWPORT_MARGIN * 2}px)`;
  menu.style.maxHeight = "min(360px, calc(100vh - 16px))";
  menu.style.overflowY = "auto";
  menu.style.padding = "4px";
  menu.style.border = "1px solid rgba(127, 127, 127, 0.24)";
  menu.style.borderRadius = "10px";
  menu.style.background = "Canvas";
  menu.style.color = "CanvasText";
  menu.style.boxShadow = "0 12px 32px rgba(0, 0, 0, 0.22)";
  ownerDocument.body.append(menu);

  if (insertBefore?.parentElement === parent) parent.insertBefore(root, insertBefore);
  else parent.append(root);

  let commands: readonly HarnessCommandDescriptor[] = [];
  let items: HTMLButtonElement[] = [];
  let activeIndex = 0;
  let executingCommandId: string | null = null;
  let triggerHovered = false;
  let disposed = false;

  const positionMenu = (): void => {
    const rect = trigger.getBoundingClientRect();
    const menuHeight = menu.getBoundingClientRect().height;
    const opensAbove = rect.top >= menuHeight + MENU_GAP + VIEWPORT_MARGIN;
    const left = clamp(
      rect.left,
      VIEWPORT_MARGIN,
      window.innerWidth - MENU_WIDTH - VIEWPORT_MARGIN,
    );
    menu.style.left = `${left}px`;
    menu.style.top = opensAbove
      ? `${Math.max(VIEWPORT_MARGIN, rect.top - menuHeight - MENU_GAP)}px`
      : `${Math.min(window.innerHeight - menuHeight - VIEWPORT_MARGIN, rect.bottom + MENU_GAP)}px`;
  };

  const focusActive = (): void => {
    const item = items[activeIndex];
    if (!item || item.disabled) return;
    item.focus();
    item.scrollIntoView({ block: "nearest" });
  };

  const syncTriggerBackground = (): void => {
    trigger.style.background =
      !trigger.disabled && (triggerHovered || !menu.hidden)
        ? "rgba(127, 127, 127, 0.16)"
        : "transparent";
  };

  const close = (): void => {
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    syncTriggerBackground();
  };

  const open = (shouldFocus = true): void => {
    if (commands.length === 0 || executingCommandId !== null) return;
    menu.hidden = false;
    positionMenu();
    trigger.setAttribute("aria-expanded", "true");
    syncTriggerBackground();
    if (shouldFocus) queueMicrotask(focusActive);
  };

  let closeTimer: number | null = null;
  const cancelClose = (): void => {
    if (closeTimer === null) return;
    window.clearTimeout(closeTimer);
    closeTimer = null;
  };
  const scheduleClose = (): void => {
    cancelClose();
    closeTimer = window.setTimeout(() => {
      closeTimer = null;
      if (!trigger.matches(":hover") && !menu.matches(":hover")) close();
    }, 140);
  };

  const select = (command: HarnessCommandDescriptor): void => {
    close();
    onCommandSelected(command);
  };

  const renderItems = (): void => {
    menu.replaceChildren();
    const header = ownerDocument.createElement("div");
    header.textContent = messages.commands;
    header.style.padding = "5px 8px 4px";
    header.style.color = "rgba(127, 127, 127, 0.75)";
    header.style.font = "600 11px/16px system-ui, sans-serif";
    menu.append(header);
    items = commands.map((command) =>
      menuItem(ownerDocument, command, locale, messages, () => select(command)),
    );
    menu.append(...items);
    activeIndex = Math.min(activeIndex, Math.max(0, items.length - 1));
    if (executingCommandId !== null) {
      for (const item of items) {
        const isExecuting = item.dataset.commandId === executingCommandId;
        item.disabled = true;
        item.style.opacity = isExecuting ? "1" : "0.5";
        if (isExecuting) item.setAttribute("aria-busy", "true");
      }
    }
  };

  const onTriggerKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  };
  const onMenuKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      trigger.focus();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      activeIndex = (activeIndex + delta + items.length) % items.length;
      focusActive();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      items[activeIndex]?.click();
    }
  };
  const onDocumentPointerDown = (event: PointerEvent): void => {
    if (
      !menu.hidden &&
      !root.contains(event.target as Node) &&
      !menu.contains(event.target as Node)
    ) {
      close();
    }
  };
  const onViewportChange = (): void => {
    if (!menu.hidden) positionMenu();
  };

  trigger.addEventListener("click", () => {
    cancelClose();
    open(true);
  });
  trigger.addEventListener("pointerenter", () => {
    triggerHovered = true;
    syncTriggerBackground();
    cancelClose();
    if (menu.hidden) open(false);
  });
  trigger.addEventListener("pointerleave", () => {
    triggerHovered = false;
    syncTriggerBackground();
    scheduleClose();
  });
  trigger.addEventListener("keydown", onTriggerKeyDown);
  menu.addEventListener("pointerenter", cancelClose);
  menu.addEventListener("pointerleave", scheduleClose);
  menu.addEventListener("keydown", onMenuKeyDown);
  ownerDocument.addEventListener("pointerdown", onDocumentPointerDown, true);
  ownerDocument.defaultView?.addEventListener("resize", onViewportChange);
  ownerDocument.defaultView?.addEventListener("scroll", onViewportChange, true);

  const control: RendererHarnessCommandControl = {
    root,
    trigger,
    menu,
    placeBefore(reference) {
      if (!reference?.parentElement) return false;
      if (root.parentElement === reference.parentElement && root.nextElementSibling === reference) {
        return true;
      }
      reference.parentElement.insertBefore(root, reference);
      return true;
    },
    setCommands(nextCommands) {
      commands = [...nextCommands];
      root.hidden = commands.length === 0;
      if (commands.length === 0) close();
      renderItems();
    },
    setExecuting(commandId) {
      executingCommandId = commandId;
      for (const item of items) {
        const isExecuting = item.dataset.commandId === commandId;
        item.disabled = commandId !== null;
        item.style.opacity = commandId !== null && !isExecuting ? "0.5" : "1";
        if (isExecuting) item.setAttribute("aria-busy", "true");
        else item.removeAttribute("aria-busy");
      }
      trigger.disabled = commandId !== null;
      trigger.style.opacity = commandId !== null ? "0.65" : "1";
      syncTriggerBackground();
    },
    setLocale(nextLocale) {
      if (locale === nextLocale) return;
      locale = nextLocale;
      messages = rendererHarnessMessages(locale);
      trigger.setAttribute("aria-label", messages.harnessCommands);
      trigger.title = messages.harnessCommands;
      menu.setAttribute("aria-label", messages.harnessCommands);
      renderItems();
    },
    close,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelClose();
      close();
      ownerDocument.removeEventListener("pointerdown", onDocumentPointerDown, true);
      ownerDocument.defaultView?.removeEventListener("resize", onViewportChange);
      ownerDocument.defaultView?.removeEventListener("scroll", onViewportChange, true);
      trigger.removeEventListener("keydown", onTriggerKeyDown);
      menu.removeEventListener("pointerenter", cancelClose);
      menu.removeEventListener("pointerleave", scheduleClose);
      menu.removeEventListener("keydown", onMenuKeyDown);
      menu.remove();
      root.remove();
    },
  };

  root.hidden = true;
  return control;
}
