import type {
  HarnessModelCatalog,
  HarnessModelRef,
  HarnessThinkingOption,
  HarnessThinkingOptionId,
} from "@codexhost/shared-contracts";

export const RENDERER_MODEL_TRIGGER_FALLBACK_CLASSES =
  "border-token-border no-drag cursor-interaction items-center gap-1 border whitespace-nowrap select-none focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 flex rounded-full text-token-text-tertiary enabled:hover:bg-token-list-hover-background enabled:active:bg-token-foreground/15 data-[state=open]:bg-token-list-hover-background border-transparent h-token-button-composer px-2 py-0 text-sm leading-[18px] min-w-0";

const MENU_CLASSES =
  "fixed z-50 overflow-hidden rounded-xl bg-token-dropdown-background/90 text-token-foreground shadow-lg ring-[0.5px] ring-token-border backdrop-blur-xl";

const OPTION_CLASSES =
  "flex w-full cursor-interaction items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-token-foreground outline-none enabled:hover:bg-token-list-hover-background enabled:active:bg-token-foreground/15 disabled:cursor-not-allowed disabled:opacity-40";

const HEADING_CLASSES = "px-2 pb-1 pt-1.5 text-sm text-token-text-tertiary";

export interface RendererModelControlView {
  status: "idle" | "waitingForAdapter" | "loading" | "ready" | "selecting" | "empty" | "error";
  catalog?: HarnessModelCatalog;
  selected?: HarnessModelRef;
  selectedThinkingOptionId?: HarnessThinkingOptionId;
  resolvedModelLabel?: string;
  thinkingSelectionSupported?: boolean;
  error?: string;
}

export interface RendererModelPickerPresentation {
  modelLabel: string;
  thinkingLabel?: string;
  resolvedModelLabel?: string;
  thinkingOptions: HarnessThinkingOption[];
  showThinkingSection: boolean;
  thinkingSelectionEnabled: boolean;
}

interface ModelOptionControl {
  button: HTMLButtonElement;
  check: HTMLElement;
}

interface ThinkingOptionControl {
  button: HTMLButtonElement;
  check: HTMLElement;
}

export interface RendererModelPickerControl {
  root: HTMLElement;
  trigger: HTMLButtonElement;
  label: HTMLElement;
  thinkingLabel: HTMLElement;
  menu: HTMLElement;
  modelMenu: HTMLElement;
  modelButton: HTMLButtonElement;
  options: Map<string, ModelOptionControl>;
  thinkingOptions: Map<string, ThinkingOptionControl>;
  close(): void;
  dispose(): void;
}

function popoverOpen(menu: HTMLElement): boolean {
  return menu.matches(":popover-open");
}

export function thinkingOptionsForModel(
  catalog: HarnessModelCatalog | undefined,
  selected: HarnessModelRef | undefined,
): HarnessThinkingOption[] {
  const supported = catalog?.models.find(
    (model) => model.ref.id === selected?.id,
  )?.supportedThinkingOptionIds;
  if (!supported) return [];
  return catalog?.thinkingOptions.filter((option) => supported.includes(option.id)) ?? [];
}

export function isRendererModelPickerDisabled(view: RendererModelControlView): boolean {
  return (
    view.status === "waitingForAdapter" ||
    view.status === "loading" ||
    view.status === "selecting" ||
    view.status === "empty" ||
    view.catalog === undefined
  );
}

export function shouldCloseRendererModelPicker(view: RendererModelControlView): boolean {
  return isRendererModelPickerDisabled(view) && view.status !== "selecting";
}

export function rendererModelPickerPresentation(
  view: RendererModelControlView,
): RendererModelPickerPresentation {
  const selectedModel = view.catalog?.models.find((model) => model.ref.id === view.selected?.id);
  const thinkingOptions =
    view.thinkingSelectionSupported === false
      ? []
      : thinkingOptionsForModel(view.catalog, view.selected);
  const selectedThinking = thinkingOptions.find(({ id }) => id === view.selectedThinkingOptionId);
  const showThinkingSection =
    thinkingOptions.length > 0 &&
    !(thinkingOptions.length === 1 && thinkingOptions[0]?.id === "off");
  const resolvedModelLabel = view.resolvedModelLabel ?? selectedModel?.resolvedModelLabel;
  let modelLabel = "Select model";
  if (selectedModel) modelLabel = selectedModel.label;
  else if (view.status === "waitingForAdapter" || view.status === "loading") {
    modelLabel = "Loading models...";
  } else if (view.status === "selecting") modelLabel = "Selecting...";
  else if (view.status === "empty") modelLabel = "No models";
  else if (view.status === "error") modelLabel = "Models unavailable";
  return {
    modelLabel,
    ...(resolvedModelLabel && resolvedModelLabel !== modelLabel ? { resolvedModelLabel } : {}),
    thinkingOptions,
    showThinkingSection,
    thinkingSelectionEnabled: thinkingOptions.length > 1,
    ...(showThinkingSection && selectedThinking ? { thinkingLabel: selectedThinking.label } : {}),
  };
}

function positionMainMenu(control: RendererModelPickerControl): void {
  const rect = control.trigger.getBoundingClientRect();
  const width = Math.min(280, Math.max(220, rect.width));
  const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
  control.menu.style.width = `${width}px`;
  control.menu.style.left = `${left}px`;
  control.menu.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 6)}px`;
}

function positionModelMenu(control: RendererModelPickerControl): void {
  const rect = control.menu.getBoundingClientRect();
  const width = Math.min(360, Math.max(280, rect.width));
  const rightCandidate = rect.right + 4;
  const left =
    rightCandidate + width <= window.innerWidth - 8
      ? rightCandidate
      : Math.max(8, rect.left - width - 4);
  control.modelMenu.style.width = `${width}px`;
  control.modelMenu.style.left = `${left}px`;
  const height = control.modelMenu.getBoundingClientRect().height;
  control.modelMenu.style.top = `${Math.max(
    8,
    Math.min(rect.top, window.innerHeight - height - 8),
  )}px`;
}

export function syncRendererModelTriggerClass(
  control: RendererModelPickerControl,
  nativeClassName?: string,
): void {
  control.trigger.className = nativeClassName?.trim() || RENDERER_MODEL_TRIGGER_FALLBACK_CLASSES;
  control.trigger.style.width = "fit-content";
  control.trigger.style.maxWidth = "min(320px, 38vw)";
}

function createCheck(): HTMLElement {
  const check = document.createElement("span");
  check.textContent = "\u2713";
  check.setAttribute("aria-hidden", "true");
  check.className = "w-4 shrink-0 text-token-text-secondary";
  check.style.width = "16px";
  check.style.flex = "none";
  return check;
}

function createHeading(text: string): HTMLElement {
  const heading = document.createElement("div");
  heading.textContent = text;
  heading.className = HEADING_CLASSES;
  heading.setAttribute("role", "presentation");
  return heading;
}

export function syncRendererLabelText(
  element: { textContent: string | null },
  text: string,
): boolean {
  if (element.textContent === text) return false;
  element.textContent = text;
  return true;
}

export function mountRendererModelPicker(
  composerId: string,
  nativeClassName: string | undefined,
  onSelectModel: (modelId: string) => void,
  onSelectThinking: (thinkingOptionId: string) => void,
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
  label.className = "truncate text-token-foreground";
  label.style.minWidth = "0";
  label.style.overflow = "hidden";
  label.style.textOverflow = "ellipsis";
  label.style.whiteSpace = "nowrap";

  const thinkingLabel = document.createElement("span");
  thinkingLabel.className = "shrink-0 truncate text-token-text-tertiary";
  thinkingLabel.style.flex = "none";
  thinkingLabel.style.maxWidth = "96px";
  thinkingLabel.style.overflow = "hidden";
  thinkingLabel.style.textOverflow = "ellipsis";
  thinkingLabel.style.whiteSpace = "nowrap";
  thinkingLabel.hidden = true;

  trigger.append(label, thinkingLabel);

  const menu = document.createElement("div");
  menu.id = `${composerId}-model-menu`;
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Model and Thinking");
  menu.setAttribute("popover", "auto");
  menu.className = MENU_CLASSES;
  menu.style.inset = "auto";
  menu.style.margin = "0";
  menu.style.padding = "4px";
  trigger.setAttribute("aria-controls", menu.id);

  const modelButton = document.createElement("button");
  modelButton.type = "button";
  modelButton.dataset.openModelMenu = "true";
  modelButton.setAttribute("role", "menuitem");
  modelButton.setAttribute("aria-haspopup", "menu");
  modelButton.setAttribute("aria-expanded", "false");
  modelButton.className = OPTION_CLASSES;

  const modelMenu = document.createElement("div");
  modelMenu.id = `${composerId}-model-submenu`;
  modelMenu.setAttribute("role", "menu");
  modelMenu.setAttribute("aria-label", "Model");
  modelMenu.setAttribute("popover", "manual");
  modelMenu.className = MENU_CLASSES;
  modelMenu.style.inset = "auto";
  modelMenu.style.margin = "0";
  modelMenu.style.padding = "4px";
  modelMenu.style.maxHeight = "min(360px, 60vh)";
  modelMenu.style.overflowY = "auto";
  modelButton.setAttribute("aria-controls", modelMenu.id);

  const options = new Map<string, ModelOptionControl>();
  const thinkingOptions = new Map<string, ThinkingOptionControl>();
  const closeModelMenu = (): void => {
    if (popoverOpen(modelMenu)) modelMenu.hidePopover();
    modelButton.setAttribute("aria-expanded", "false");
  };
  const close = (): void => {
    closeModelMenu();
    if (popoverOpen(menu)) menu.hidePopover();
  };
  const openModelMenu = (): void => {
    if (!popoverOpen(menu) || popoverOpen(modelMenu)) return;
    modelMenu.showPopover();
    positionModelMenu(control);
    modelButton.setAttribute("aria-expanded", "true");
  };
  const open = (): void => {
    if (trigger.disabled || popoverOpen(menu)) return;
    positionMainMenu(control);
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
    if (!openState) closeModelMenu();
  };
  const onModelToggle = (): void => {
    modelButton.setAttribute("aria-expanded", String(popoverOpen(modelMenu)));
  };
  const onRootClick = (event: MouseEvent): void => {
    const target =
      event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button") : null;
    if (target?.dataset.openModelMenu) {
      openModelMenu();
      return;
    }
    if (target?.dataset.modelId) {
      closeModelMenu();
      modelButton.focus();
      onSelectModel(target.dataset.modelId);
      return;
    }
    if (target?.dataset.thinkingOptionId) {
      close();
      trigger.focus();
      onSelectThinking(target.dataset.thinkingOptionId);
    }
  };
  const onModelHover = (): void => openModelMenu();
  trigger.addEventListener("click", onTriggerClick);
  menu.addEventListener("toggle", onToggle);
  modelMenu.addEventListener("toggle", onModelToggle);
  modelButton.addEventListener("mouseenter", onModelHover);
  root.addEventListener("click", onRootClick);
  menu.append(modelMenu);
  root.append(trigger, menu);

  const control: RendererModelPickerControl = {
    root,
    trigger,
    label,
    thinkingLabel,
    menu,
    modelMenu,
    modelButton,
    options,
    thinkingOptions,
    close,
    dispose() {
      close();
      trigger.removeEventListener("click", onTriggerClick);
      menu.removeEventListener("toggle", onToggle);
      modelMenu.removeEventListener("toggle", onModelToggle);
      modelButton.removeEventListener("mouseenter", onModelHover);
      root.removeEventListener("click", onRootClick);
      root.remove();
    },
  };
  syncRendererModelTriggerClass(control, nativeClassName);
  return control;
}

function rebuildOptions(control: RendererModelPickerControl, view: RendererModelControlView): void {
  const presentation = rendererModelPickerPresentation(view);
  control.options.clear();
  control.thinkingOptions.clear();
  control.menu.replaceChildren();
  control.modelMenu.replaceChildren(createHeading("Model"));

  if (presentation.showThinkingSection) {
    control.menu.append(createHeading("Thinking"));
    for (const option of presentation.thinkingOptions) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.thinkingOptionId = option.id;
      button.setAttribute("role", "menuitemradio");
      button.className = OPTION_CLASSES;

      const text = document.createElement("span");
      text.textContent = option.label;
      text.className = "min-w-0 flex-1 truncate";
      const check = createCheck();
      button.append(text, check);
      control.thinkingOptions.set(option.id, { button, check });
      control.menu.append(button);
    }
    const divider = document.createElement("div");
    divider.setAttribute("role", "separator");
    divider.className = "my-1 h-px bg-token-border";
    control.menu.append(divider);
  }

  const modelText = document.createElement("span");
  modelText.textContent = presentation.modelLabel;
  modelText.className = "min-w-0 flex-1 truncate";
  modelText.title = presentation.modelLabel;
  const modelChevron = document.createElement("span");
  modelChevron.textContent = "\u203a";
  modelChevron.setAttribute("aria-hidden", "true");
  modelChevron.className = "shrink-0 text-token-text-tertiary";
  control.modelButton.replaceChildren(modelText, modelChevron);
  control.menu.append(control.modelButton);

  for (const model of view.catalog?.models ?? []) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.modelId = model.ref.id;
    button.setAttribute("role", "menuitemradio");
    button.className = OPTION_CLASSES;

    const text = document.createElement("span");
    text.textContent = model.label;
    text.className = "min-w-0 flex-1 truncate";
    text.title = model.label;
    const check = createCheck();
    button.append(text, check);
    control.options.set(model.ref.id, { button, check });
    control.modelMenu.append(button);
  }
  control.menu.append(control.modelMenu);
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
  const presentation = rendererModelPickerPresentation(view);
  const catalogSignature = JSON.stringify({
    models: view.catalog?.models,
    thinkingOptions: presentation.thinkingOptions,
    showThinkingSection: presentation.showThinkingSection,
    modelLabel: presentation.modelLabel,
  });
  if (control.root.dataset.catalogSignature !== catalogSignature) {
    rebuildOptions(control, view);
    control.root.dataset.catalogSignature = catalogSignature;
  }

  syncRendererLabelText(control.label, presentation.modelLabel);
  const secondaryLabel = presentation.thinkingLabel ?? presentation.resolvedModelLabel;
  syncRendererLabelText(control.thinkingLabel, secondaryLabel ?? "");
  control.thinkingLabel.hidden = secondaryLabel === undefined;
  const accessibleLabel = secondaryLabel
    ? `${presentation.modelLabel}, ${secondaryLabel}`
    : presentation.modelLabel;
  control.trigger.title = view.error ?? accessibleLabel;
  control.trigger.setAttribute("aria-label", `Model: ${accessibleLabel}`);
  control.trigger.setAttribute(
    "aria-busy",
    String(view.status === "loading" || view.status === "selecting"),
  );
  control.trigger.disabled = isRendererModelPickerDisabled(view);
  if (shouldCloseRendererModelPicker(view)) control.close();
  control.modelButton.disabled = control.trigger.disabled;

  for (const [modelId, option] of control.options) {
    const selected = modelId === view.selected?.id;
    option.button.setAttribute("aria-checked", String(selected));
    option.button.classList.toggle("bg-token-list-hover-background", selected);
    option.button.disabled = control.trigger.disabled;
    option.check.style.visibility = selected ? "visible" : "hidden";
  }
  for (const [thinkingOptionId, option] of control.thinkingOptions) {
    const selected = thinkingOptionId === view.selectedThinkingOptionId;
    option.button.setAttribute("aria-checked", String(selected));
    option.button.classList.toggle("bg-token-list-hover-background", selected);
    option.button.disabled = control.trigger.disabled || !presentation.thinkingSelectionEnabled;
    option.check.style.visibility = selected ? "visible" : "hidden";
  }
}
