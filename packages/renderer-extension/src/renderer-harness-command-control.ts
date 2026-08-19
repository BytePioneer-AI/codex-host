import type { HarnessCommandDescriptor } from "@codexhost/shared-contracts";

const CONTROL_ATTRIBUTE = "data-codexhost-harness-command-control";
const MENU_ATTRIBUTE = "data-codexhost-harness-command-menu";
const MENU_WIDTH = 320;
const VIEWPORT_MARGIN = 8;
const MENU_GAP = 8;

export interface RendererHarnessCommandControl {
  root: HTMLElement;
  trigger: HTMLButtonElement;
  menu: HTMLElement;
  setCommands(commands: readonly HarnessCommandDescriptor[]): void;
  setExecuting(commandId: string | null): void;
  placeBefore(reference: Element | null): boolean;
  close(): void;
  dispose(): void;
}

function menuItem(
  ownerDocument: Document,
  command: HarnessCommandDescriptor,
  onSelect: () => void,
): HTMLButtonElement {
  const item = ownerDocument.createElement("button");
  item.type = "button";
  item.setAttribute("role", "menuitem");
  item.setAttribute("data-command-id", command.id);
  item.setAttribute("aria-label", `${command.invocation} ${command.label}`);
  item.style.display = "flex";
  item.style.alignItems = "center";
  item.style.width = "100%";
  item.style.minHeight = "48px";
  item.style.gap = "10px";
  item.style.padding = "7px 9px";
  item.style.border = "0";
  item.style.borderRadius = "8px";
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
  description.textContent = command.description ?? command.label;
  description.style.overflow = "hidden";
  description.style.color = "rgba(127, 127, 127, 0.9)";
  description.style.font = "400 11px/16px system-ui, sans-serif";
  description.style.textOverflow = "ellipsis";
  description.style.whiteSpace = "nowrap";

  const hint = ownerDocument.createElement("span");
  hint.textContent = command.argumentMode === "text" ? "Text" : "↵";
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
  button.style.height = "36px";
  button.style.maxWidth = "220px";
  button.style.padding = "0 11px 0 8px";
  button.style.border = "1px solid rgba(127, 127, 127, 0.23)";
  button.style.borderRadius = "10px";
  button.style.background = "rgba(127, 127, 127, 0.04)";
  button.style.color = "inherit";
  button.style.font = "600 12px/16px system-ui, sans-serif";
  button.style.cursor = "pointer";
  button.style.whiteSpace = "nowrap";
}

export function mountRendererHarnessCommandControl(
  parent: Element,
  insertBefore: Element | null,
  onCommandSelected: (command: HarnessCommandDescriptor) => void,
): RendererHarnessCommandControl {
  const ownerDocument = parent.ownerDocument;
  const root = ownerDocument.createElement("div");
  root.setAttribute(CONTROL_ATTRIBUTE, "true");
  root.style.display = "inline-flex";
  root.style.alignItems = "center";
  root.style.minWidth = "0";

  const trigger = ownerDocument.createElement("button");
  trigger.type = "button";
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-label", "Harness commands");
  setButtonClass(trigger);

  const label = ownerDocument.createElement("span");
  label.textContent = "Commands";
  label.style.overflow = "hidden";
  label.style.textOverflow = "ellipsis";
  label.style.whiteSpace = "nowrap";
  trigger.append(label);
  root.append(trigger);

  const menu = ownerDocument.createElement("div");
  menu.setAttribute(MENU_ATTRIBUTE, "true");
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Harness commands");
  menu.hidden = true;
  menu.style.position = "fixed";
  menu.style.inset = "auto";
  menu.style.zIndex = "2147483647";
  menu.style.width = `${MENU_WIDTH}px`;
  menu.style.maxWidth = `calc(100vw - ${VIEWPORT_MARGIN * 2}px)`;
  menu.style.maxHeight = "min(360px, calc(100vh - 16px))";
  menu.style.overflowY = "auto";
  menu.style.padding = "6px";
  menu.style.border = "1px solid rgba(127, 127, 127, 0.24)";
  menu.style.borderRadius = "12px";
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

  const close = (): void => {
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  };

  const open = (): void => {
    if (commands.length === 0 || executingCommandId !== null) return;
    menu.hidden = false;
    positionMenu();
    trigger.setAttribute("aria-expanded", "true");
    queueMicrotask(focusActive);
  };

  const select = (command: HarnessCommandDescriptor): void => {
    close();
    onCommandSelected(command);
  };

  const renderItems = (): void => {
    menu.replaceChildren();
    const header = ownerDocument.createElement("div");
    header.textContent = "Harness commands";
    header.style.padding = "7px 9px 6px";
    header.style.color = "rgba(127, 127, 127, 0.9)";
    header.style.font = "700 10px/14px system-ui, sans-serif";
    header.style.letterSpacing = "0.08em";
    header.style.textTransform = "uppercase";
    menu.append(header);
    items = commands.map((command) => menuItem(ownerDocument, command, () => select(command)));
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
    if (menu.hidden) open();
    else close();
  });
  trigger.addEventListener("keydown", onTriggerKeyDown);
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
    },
    close,
    dispose() {
      if (disposed) return;
      disposed = true;
      close();
      ownerDocument.removeEventListener("pointerdown", onDocumentPointerDown, true);
      ownerDocument.defaultView?.removeEventListener("resize", onViewportChange);
      ownerDocument.defaultView?.removeEventListener("scroll", onViewportChange, true);
      trigger.removeEventListener("keydown", onTriggerKeyDown);
      menu.removeEventListener("keydown", onMenuKeyDown);
      menu.remove();
      root.remove();
    },
  };

  root.hidden = true;
  return control;
}
