import type { HarnessModelCatalog, HarnessModelRef } from "@codexhost/shared-contracts";

const FALLBACK_TRIGGER_CLASSES =
  "border-token-border no-drag cursor-interaction items-center gap-1 border whitespace-nowrap select-none focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 flex rounded-full text-token-text-tertiary enabled:hover:bg-token-list-hover-background enabled:active:bg-token-foreground/15 data-[state=open]:bg-token-list-hover-background border-transparent h-token-button-composer px-2 py-0 text-sm leading-[18px] min-w-0";

const MENU_CLASSES =
  "fixed z-50 overflow-hidden rounded-xl bg-token-dropdown-background/90 text-token-foreground shadow-lg ring-[0.5px] ring-token-border backdrop-blur-xl";

const OPTION_CLASSES =
  "flex w-full cursor-interaction items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-token-foreground outline-none enabled:hover:bg-token-list-hover-background enabled:active:bg-token-foreground/15 disabled:cursor-not-allowed disabled:opacity-40";

export interface RendererModelControlView {
  status: "idle" | "loading" | "ready" | "selecting" | "empty" | "error";
  catalog?: HarnessModelCatalog;
  selected?: HarnessModelRef;
  error?: string;
}

interface ModelOptionControl {
  button: HTMLButtonElement;
  check: HTMLElement;
}

export interface RendererModelPickerControl {
  root: HTMLElement;
  trigger: HTMLButtonElement;
  label: HTMLElement;
  menu: HTMLElement;
  options: Map<string, ModelOptionControl>;
  close(): void;
  dispose(): void;
}

function popoverOpen(menu: HTMLElement): boolean {
  return menu.matches(":popover-open");
}

function positionMenu(control: RendererModelPickerControl): void {
  const rect = control.trigger.getBoundingClientRect();
  const width = Math.min(320, Math.max(240, rect.width));
  const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
  control.menu.style.width = `${width}px`;
  control.menu.style.left = `${left}px`;
  control.menu.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 6)}px`;
}

export function syncRendererModelTriggerClass(
  control: RendererModelPickerControl,
  nativeClassName?: string,
): void {
  control.trigger.className = nativeClassName?.trim() || FALLBACK_TRIGGER_CLASSES;
  control.trigger.style.maxWidth = "min(320px, 38vw)";
}

export function mountRendererModelPicker(
  composerId: string,
  nativeClassName: string | undefined,
  onSelect: (modelId: string) => void,
): RendererModelPickerControl {
  const root = document.createElement("div");
  root.setAttribute("data-codexhost-model-control", composerId);
  root.className = "relative min-w-0";
  root.style.display = "none";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("data-state", "closed");

  const label = document.createElement("span");
  label.className = "truncate";
  label.style.minWidth = "0";
  label.style.overflow = "hidden";
  label.style.textOverflow = "ellipsis";
  label.style.whiteSpace = "nowrap";
  trigger.append(label);

  const menu = document.createElement("div");
  menu.id = `${composerId}-model-menu`;
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Model");
  menu.setAttribute("popover", "auto");
  menu.className = MENU_CLASSES;
  menu.style.inset = "auto";
  menu.style.margin = "0";
  menu.style.padding = "4px";
  menu.style.maxHeight = "min(360px, 60vh)";
  menu.style.overflowY = "auto";
  trigger.setAttribute("aria-controls", menu.id);

  const options = new Map<string, ModelOptionControl>();
  const close = (): void => {
    if (popoverOpen(menu)) menu.hidePopover();
  };
  const open = (): void => {
    if (trigger.disabled || popoverOpen(menu)) return;
    positionMenu(control);
    menu.showPopover();
  };
  const onTriggerClick = (): void => {
    if (popoverOpen(menu)) close();
    else open();
  };
  const onToggle = (): void => {
    const openState = popoverOpen(menu);
    trigger.setAttribute("aria-expanded", String(openState));
    trigger.setAttribute("data-state", openState ? "open" : "closed");
  };
  const selectModel = (modelId: string): void => {
    close();
    trigger.focus();
    onSelect(modelId);
  };
  const onOptionClick = (event: MouseEvent): void => {
    const target =
      event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>("button[data-model-id]")
        : null;
    if (target?.dataset.modelId) selectModel(target.dataset.modelId);
  };
  trigger.addEventListener("click", onTriggerClick);
  menu.addEventListener("toggle", onToggle);
  root.addEventListener("click", onOptionClick);
  root.append(trigger, menu);

  const control: RendererModelPickerControl = {
    root,
    trigger,
    label,
    menu,
    options,
    close,
    dispose() {
      close();
      trigger.removeEventListener("click", onTriggerClick);
      menu.removeEventListener("toggle", onToggle);
      root.removeEventListener("click", onOptionClick);
      root.remove();
    },
  };
  syncRendererModelTriggerClass(control, nativeClassName);
  return control;
}

function rebuildOptions(
  control: RendererModelPickerControl,
  catalog: HarnessModelCatalog | undefined,
): void {
  control.options.clear();
  control.menu.replaceChildren();
  for (const model of catalog?.models ?? []) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.modelId = model.ref.id;
    button.setAttribute("role", "menuitemradio");
    button.className = OPTION_CLASSES;

    const check = document.createElement("span");
    check.textContent = "\u2713";
    check.setAttribute("aria-hidden", "true");
    check.className = "w-4 shrink-0 text-token-text-secondary";
    check.style.width = "16px";
    check.style.flex = "none";

    const label = document.createElement("span");
    label.textContent = model.label;
    label.className = "min-w-0 flex-1 truncate";
    label.title = model.label;
    button.append(check, label);
    control.options.set(model.ref.id, { button, check });
    control.menu.append(button);
  }
}

function triggerLabel(view: RendererModelControlView): string {
  const selected = view.catalog?.models.find((model) => model.ref.id === view.selected?.id);
  if (selected) return selected.label;
  if (view.status === "loading") return "Loading models...";
  if (view.status === "selecting") return "Selecting model...";
  if (view.status === "empty") return "No Pi models";
  if (view.status === "error") return "Models unavailable";
  return "Select model";
}

export function renderRendererModelPicker(
  control: RendererModelPickerControl,
  view: RendererModelControlView,
  visible: boolean,
): void {
  control.root.style.display = visible ? "block" : "none";
  if (!visible) {
    control.close();
    return;
  }
  const catalogSignature =
    view.catalog?.models.map((model) => `${model.ref.id}\u0000${model.label}`).join("\u0001") ??
    `:${view.status}`;
  if (control.root.dataset.catalogSignature !== catalogSignature) {
    rebuildOptions(control, view.catalog);
    control.root.dataset.catalogSignature = catalogSignature;
  }

  const text = triggerLabel(view);
  if (control.label.textContent !== text) control.label.textContent = text;
  control.trigger.title = view.error ?? text;
  control.trigger.setAttribute("aria-label", `Model: ${text}`);
  control.trigger.setAttribute("aria-busy", String(view.status === "loading"));
  control.trigger.disabled =
    view.status === "loading" ||
    view.status === "selecting" ||
    view.status === "empty" ||
    view.status === "error" ||
    view.catalog === undefined;
  if (control.trigger.disabled) control.close();

  for (const [modelId, option] of control.options) {
    const selected = modelId === view.selected?.id;
    option.button.setAttribute("aria-checked", String(selected));
    option.button.classList.toggle("bg-token-list-hover-background", selected);
    option.check.style.visibility = selected ? "visible" : "hidden";
  }
}
