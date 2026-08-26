import type {
  HarnessPermissionMode,
  HarnessPermissionModeCatalog,
  HarnessPermissionModeId,
} from "@codexhost/shared-contracts";
import type { IconNode } from "lucide";
import createElement from "lucide/dist/esm/createElement.mjs";
import Check from "lucide/dist/esm/icons/check.mjs";
import ChevronDown from "lucide/dist/esm/icons/chevron-down.mjs";
import Shield from "lucide/dist/esm/icons/shield.mjs";
import ShieldAlert from "lucide/dist/esm/icons/shield-alert.mjs";

import {
  ensureRendererTriggerChipStyle,
  TRIGGER_CHIP_CLASS,
} from "./renderer-trigger-chip-style.js";

const MENU_CLASSES =
  "fixed z-50 overflow-hidden rounded-lg bg-token-dropdown-background/95 text-token-foreground shadow-lg ring-[0.5px] ring-token-border backdrop-blur-xl";

const OPTION_CLASSES =
  "flex w-full cursor-interaction items-start gap-2 rounded-md px-2 py-2 text-left text-sm text-token-foreground outline-none enabled:hover:bg-token-list-hover-background enabled:active:bg-token-foreground/15 disabled:cursor-not-allowed disabled:opacity-40";

export interface RendererPermissionModeControlView {
  status: "idle" | "loading" | "ready" | "selecting" | "unsupported" | "error";
  catalog?: HarnessPermissionModeCatalog;
  selected?: HarnessPermissionModeId;
  error?: string;
}

interface PermissionModeOptionControl {
  button: HTMLButtonElement;
  check: SVGElement;
  mode: HarnessPermissionMode;
}

export interface RendererPermissionModePickerControl {
  root: HTMLElement;
  trigger: HTMLButtonElement;
  label: HTMLElement;
  menu: HTMLElement;
  options: Map<string, PermissionModeOptionControl>;
  close(): void;
  dispose(): void;
}

function icon(node: IconNode, size: number): SVGElement {
  return createElement(node, {
    width: size,
    height: size,
    "aria-hidden": "true",
    focusable: "false",
    strokeWidth: 1.8,
  });
}

function popoverOpen(menu: HTMLElement): boolean {
  try {
    return menu.matches(":popover-open");
  } catch {
    return !menu.hidden;
  }
}

function selectedMode(view: RendererPermissionModeControlView): HarnessPermissionMode | undefined {
  return view.catalog?.modes.find(({ id }) => id === view.selected);
}

export function isPermissionModeControlReady(view: RendererPermissionModeControlView): boolean {
  if (view.status === "unsupported") return true;
  return (view.status === "ready" || view.status === "error") && selectedMode(view) !== undefined;
}

export function rendererPermissionModeLabel(view: RendererPermissionModeControlView): string {
  const selected = selectedMode(view);
  if (selected) return selected.label;
  if (view.status === "loading") return "Loading permissions...";
  if (view.status === "selecting") return "Selecting...";
  if (view.status === "error") return "Permissions unavailable";
  return "Permissions";
}

function positionMenu(control: RendererPermissionModePickerControl): void {
  const rect = control.trigger.getBoundingClientRect();
  const width = Math.min(320, window.innerWidth - 16);
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  control.menu.style.width = `${width}px`;
  control.menu.style.left = `${left}px`;
  control.menu.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 6)}px`;
}

export function syncRendererPermissionModeTriggerClass(
  control: RendererPermissionModePickerControl,
): void {
  // Do not copy Codex's private Composer classes into codexhost controls.
  // Codex can rename or remove those between Desktop releases; our own
  // `TRIGGER_CHIP_CLASS` chrome (see renderer-trigger-chip-style.ts) does not.
  control.trigger.className = TRIGGER_CHIP_CLASS;
  control.trigger.style.maxWidth = "min(220px, 34vw)";
  control.trigger.style.letterSpacing = "0";
}

export function mountRendererPermissionModePicker(
  composerId: string,
  onSelect: (permissionModeId: string) => void,
): RendererPermissionModePickerControl {
  ensureRendererTriggerChipStyle(document);

  const root = document.createElement("div");
  root.setAttribute("data-codexhost-permission-mode-control", composerId);
  root.className = "relative min-w-0";
  root.style.display = "none";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("data-state", "closed");
  trigger.style.height = "28px";
  trigger.style.padding = "0 6px";
  trigger.style.gap = "4px";
  trigger.style.font = "400 13px/18px system-ui, sans-serif";

  const shield = document.createElement("span");
  shield.className = "inline-flex shrink-0 items-center";
  shield.append(icon(Shield, 15));

  const label = document.createElement("span");
  label.className = "truncate";
  label.style.minWidth = "0";
  label.style.overflow = "hidden";
  label.style.textOverflow = "ellipsis";
  label.style.whiteSpace = "nowrap";

  const chevron = document.createElement("span");
  chevron.className = "inline-flex shrink-0 items-center";
  chevron.style.color = "var(--color-text-tertiary, #8f8f8f)";
  chevron.append(icon(ChevronDown, 14));
  trigger.append(shield, label, chevron);

  const menu = document.createElement("div");
  menu.id = `${composerId}-permission-mode-menu`;
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Permission mode");
  menu.setAttribute("popover", "auto");
  menu.hidden = typeof menu.showPopover !== "function";
  menu.className = MENU_CLASSES;
  menu.style.inset = "auto";
  menu.style.margin = "0";
  menu.style.padding = "4px";
  menu.style.maxHeight = "min(420px, 70vh)";
  menu.style.overflowY = "auto";
  trigger.setAttribute("aria-controls", menu.id);

  const options = new Map<string, PermissionModeOptionControl>();
  const close = (): void => {
    if (!popoverOpen(menu)) return;
    if (typeof menu.hidePopover === "function") menu.hidePopover();
    else menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("data-state", "closed");
  };
  const focusOption = (position: "first" | "last" | "selected"): void => {
    const available = [...options.values()]
      .map(({ button }) => button)
      .filter((button) => !button.disabled);
    const selected = available.find((button) => button.getAttribute("aria-checked") === "true");
    const target =
      position === "last" ? available.at(-1) : position === "selected" ? selected : available[0];
    target?.focus();
  };
  const open = (focus: "first" | "last" | "selected" = "selected"): void => {
    if (trigger.disabled || popoverOpen(menu)) return;
    positionMenu(control);
    if (typeof menu.showPopover === "function") menu.showPopover();
    else menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    trigger.setAttribute("data-state", "open");
    queueMicrotask(() => focusOption(focus));
  };
  const onTriggerClick = (): void => {
    if (popoverOpen(menu)) close();
    else open();
  };
  const onTriggerKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    open(event.key === "ArrowUp" ? "last" : "first");
  };
  const onMenuClick = (event: MouseEvent): void => {
    const button =
      event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>("button[data-permission-mode-id]")
        : null;
    const permissionModeId = button?.dataset.permissionModeId;
    if (!permissionModeId || button.disabled) return;
    close();
    trigger.focus();
    onSelect(permissionModeId);
  };
  const onMenuKeyDown = (event: KeyboardEvent): void => {
    const buttons = [...options.values()]
      .map(({ button }) => button)
      .filter((button) => !button.disabled);
    const current = event.target instanceof Element ? event.target.closest("button") : null;
    const index = buttons.indexOf(current as HTMLButtonElement);
    if (event.key === "Escape") {
      close();
      trigger.focus();
      return;
    }
    if (event.key === "Tab") {
      close();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const target =
      event.key === "Home"
        ? buttons[0]
        : event.key === "End"
          ? buttons.at(-1)
          : event.key === "ArrowDown"
            ? buttons[(index + 1 + buttons.length) % buttons.length]
            : buttons[(index - 1 + buttons.length) % buttons.length];
    target?.focus();
  };
  const onToggle = (): void => {
    const openState = popoverOpen(menu);
    trigger.setAttribute("aria-expanded", String(openState));
    trigger.setAttribute("data-state", openState ? "open" : "closed");
  };
  const onViewportChange = (): void => {
    if (popoverOpen(menu)) positionMenu(control);
  };
  trigger.addEventListener("click", onTriggerClick);
  trigger.addEventListener("keydown", onTriggerKeyDown);
  menu.addEventListener("click", onMenuClick);
  menu.addEventListener("keydown", onMenuKeyDown);
  menu.addEventListener("toggle", onToggle);
  window.addEventListener("resize", onViewportChange);
  window.addEventListener("scroll", onViewportChange, true);
  root.append(trigger, menu);

  const control: RendererPermissionModePickerControl = {
    root,
    trigger,
    label,
    menu,
    options,
    close,
    dispose() {
      close();
      trigger.removeEventListener("click", onTriggerClick);
      trigger.removeEventListener("keydown", onTriggerKeyDown);
      menu.removeEventListener("click", onMenuClick);
      menu.removeEventListener("keydown", onMenuKeyDown);
      menu.removeEventListener("toggle", onToggle);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
      root.remove();
    },
  };
  syncRendererPermissionModeTriggerClass(control);
  return control;
}

function rebuildOptions(
  control: RendererPermissionModePickerControl,
  catalog: HarnessPermissionModeCatalog,
): void {
  control.options.clear();
  control.menu.replaceChildren();
  for (const mode of catalog.modes) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.permissionModeId = mode.id;
    button.setAttribute("role", "menuitemradio");
    button.className = OPTION_CLASSES;
    button.style.letterSpacing = "0";
    if (mode.dangerous) button.style.color = "var(--color-text-danger, #c2413b)";

    const modeIcon = document.createElement("span");
    modeIcon.className = "inline-flex h-5 w-5 shrink-0 items-center justify-center";
    modeIcon.append(icon(mode.dangerous ? ShieldAlert : Shield, 17));

    const copy = document.createElement("span");
    copy.className = "min-w-0 flex-1";
    const title = document.createElement("span");
    title.textContent = mode.label;
    title.className = "block font-medium";
    title.style.letterSpacing = "0";
    copy.append(title);
    if (mode.description) {
      const description = document.createElement("span");
      description.textContent = mode.description;
      description.className = "mt-0.5 block text-xs text-token-text-tertiary";
      description.style.lineHeight = "16px";
      description.style.letterSpacing = "0";
      description.style.whiteSpace = "normal";
      copy.append(description);
    }

    const check = icon(Check, 16);
    check.classList.add("mt-0.5", "shrink-0");
    check.style.visibility = "hidden";
    button.append(modeIcon, copy, check);
    control.options.set(mode.id, { button, check, mode });
    control.menu.append(button);
  }
}

export function renderRendererPermissionModePicker(
  control: RendererPermissionModePickerControl,
  view: RendererPermissionModeControlView,
  visible: boolean,
): void {
  control.root.style.display = visible ? "inline-flex" : "none";
  control.root.style.alignItems = "center";
  control.root.style.alignSelf = "center";
  control.root.style.height = "28px";
  control.root.style.flex = "0 0 auto";
  control.root.style.verticalAlign = "middle";
  if (!visible) {
    control.close();
    return;
  }
  const signature = JSON.stringify(view.catalog);
  if (view.catalog && control.root.dataset.catalogSignature !== signature) {
    rebuildOptions(control, view.catalog);
    control.root.dataset.catalogSignature = signature;
  }
  const label = rendererPermissionModeLabel(view);
  if (control.label.textContent !== label) control.label.textContent = label;
  control.trigger.title = view.error ? `${label}: ${view.error}` : label;
  control.trigger.setAttribute("aria-label", `Permission mode: ${label}`);
  control.trigger.disabled =
    view.status === "loading" || view.status === "selecting" || view.catalog === undefined;
  control.trigger.setAttribute("aria-busy", String(view.status === "selecting"));
  if (control.trigger.disabled) control.close();

  for (const [id, option] of control.options) {
    const selected = id === view.selected;
    option.button.disabled = view.status !== "ready" && view.status !== "error";
    option.button.setAttribute("aria-checked", String(selected));
    option.check.style.visibility = selected ? "visible" : "hidden";
  }
}
