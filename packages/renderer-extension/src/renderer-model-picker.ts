import type {
  HarnessModelCatalog,
  HarnessModelRef,
  HarnessThinkingOption,
  HarnessThinkingOptionId,
} from "@codexhost/shared-contracts";

export const RENDERER_MODEL_TRIGGER_FALLBACK_CLASSES =
  "border-token-border no-drag cursor-interaction items-center gap-1 border whitespace-nowrap select-none focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 flex rounded-full text-token-text-tertiary enabled:hover:bg-token-list-hover-background enabled:active:bg-token-foreground/15 data-[state=open]:bg-token-list-hover-background border-transparent h-token-button-composer px-2 py-0 text-sm leading-[18px] min-w-0";

const MENU_CLASSES =
  "fixed z-50 overflow-hidden rounded-xl bg-token-dropdown-background/90 text-token-foreground shadow-lg backdrop-blur-xl";

const SEARCH_INPUT_CLASSES =
  "mb-1 w-full shrink-0 rounded-lg border border-token-border bg-token-dropdown-background/95 px-2 py-1.5 text-sm text-token-foreground outline-none placeholder:text-token-text-tertiary disabled:cursor-not-allowed disabled:opacity-40";

const OPTION_CLASSES =
  "flex w-full cursor-interaction items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-token-foreground outline-none enabled:hover:bg-token-list-hover-background enabled:active:bg-token-foreground/15 disabled:cursor-not-allowed disabled:opacity-40";

const HEADING_CLASSES = "px-2 pb-1 pt-1.5 text-sm text-token-text-tertiary";
const MAIN_MENU_MIN_WIDTH = 160;
const MAIN_MENU_MAX_WIDTH = 180;
const MODEL_MENU_PREFERRED_WIDTH = 360;
const MODEL_MENU_MAX_WIDTH = 420;
const MODEL_MENU_MAX_HEIGHT = 360;
const MODEL_TRIGGER_MAX_WIDTH = "min(200px, 26vw)";
const MAIN_MENU_LEFT_OFFSET = 96;
const MENU_GAP = 4;
const VIEWPORT_MARGIN = 8;
const MODEL_SCROLLBAR_STYLE_ATTRIBUTE = "data-codexhost-model-picker-scrollbar";

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
  searchText: string;
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
  searchInput: HTMLInputElement;
  searchHeader: HTMLElement;
  searchEmpty: HTMLElement;
  options: Map<string, ModelOptionControl>;
  thinkingOptions: Map<string, ThinkingOptionControl>;
  close(): void;
  dispose(): void;
}

function popoverOpen(menu: HTMLElement): boolean {
  return menu.matches(":popover-open");
}

function ensureModelScrollbarStyle(ownerDocument: Document): void {
  if (ownerDocument.querySelector(`style[${MODEL_SCROLLBAR_STYLE_ATTRIBUTE}]`)) return;
  const style = ownerDocument.createElement("style");
  style.setAttribute(MODEL_SCROLLBAR_STYLE_ATTRIBUTE, "true");
  style.textContent = `
    [data-codexhost-model-scrollable] {
      scrollbar-width: thin;
      scrollbar-color: rgba(255, 255, 255, 0.28) transparent;
    }
    [data-codexhost-model-scrollable]::-webkit-scrollbar {
      width: 6px;
      height: 6px;
    }
    [data-codexhost-model-scrollable]::-webkit-scrollbar-track {
      background: transparent;
    }
    [data-codexhost-model-scrollable]::-webkit-scrollbar-thumb {
      min-height: 28px;
      border: 1px solid transparent;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.28);
      background-clip: padding-box;
    }
    [data-codexhost-model-scrollable]::-webkit-scrollbar-thumb:hover {
      background: rgba(255, 255, 255, 0.42);
      background-clip: padding-box;
    }
    [data-codexhost-model-scrollable]::-webkit-scrollbar-button {
      display: none;
      width: 0;
      height: 0;
    }
  `;
  (ownerDocument.head ?? ownerDocument.documentElement).append(style);
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

function isTransientPickerState(view: RendererModelControlView): boolean {
  return view.status === "idle" || view.status === "loading";
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
  const triggerRect = control.trigger.getBoundingClientRect();
  const width = Math.min(MAIN_MENU_MAX_WIDTH, Math.max(MAIN_MENU_MIN_WIDTH, triggerRect.width));
  const modelMenuWidth = Math.min(
    MODEL_MENU_MAX_WIDTH,
    Math.min(MODEL_MENU_PREFERRED_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2),
  );
  const preferredLeft = triggerRect.right - width - MAIN_MENU_LEFT_OFFSET;
  const rightReservedLeft = window.innerWidth - VIEWPORT_MARGIN - modelMenuWidth - MENU_GAP - width;
  const maxLeft = window.innerWidth - VIEWPORT_MARGIN - width;
  const left = Math.max(
    VIEWPORT_MARGIN,
    Math.min(preferredLeft, Math.max(rightReservedLeft, VIEWPORT_MARGIN), maxLeft),
  );
  control.menu.style.setProperty("width", `${width}px`, "important");
  control.menu.style.left = `${left}px`;
  control.menu.style.maxWidth = `${width}px`;
  control.menu.style.right = "auto";
  control.menu.style.top = "auto";
  control.menu.style.bottom = `${Math.max(
    VIEWPORT_MARGIN,
    window.innerHeight - triggerRect.top + 6,
  )}px`;
}

function positionModelMenu(control: RendererModelPickerControl): void {
  const mainRect = control.menu.getBoundingClientRect();
  const availableRight = window.innerWidth - mainRect.right - VIEWPORT_MARGIN;
  const width = Math.min(MODEL_MENU_MAX_WIDTH, Math.max(VIEWPORT_MARGIN, availableRight));
  const left = mainRect.right + MENU_GAP;
  control.modelMenu.style.setProperty("width", `${width}px`, "important");
  control.modelMenu.style.left = `${left}px`;
  control.modelMenu.style.maxWidth = `${width}px`;
  const maxHeight = Math.max(
    VIEWPORT_MARGIN,
    Math.min(MODEL_MENU_MAX_HEIGHT, window.innerHeight * 0.6, mainRect.bottom - VIEWPORT_MARGIN),
  );
  control.modelMenu.style.maxHeight = `${maxHeight}px`;
  control.modelMenu.style.right = "auto";
  control.modelMenu.style.top = "auto";
  control.modelMenu.style.bottom = `${Math.max(
    VIEWPORT_MARGIN,
    window.innerHeight - mainRect.bottom,
  )}px`;
}

export function syncRendererModelTriggerClass(
  control: RendererModelPickerControl,
  nativeClassName?: string,
): void {
  control.trigger.className = nativeClassName?.trim() || RENDERER_MODEL_TRIGGER_FALLBACK_CLASSES;
  control.trigger.style.width = "fit-content";
  control.trigger.style.maxWidth = MODEL_TRIGGER_MAX_WIDTH;
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

function applyModelSearchFilter(control: RendererModelPickerControl): void {
  const query = control.searchInput.value.trim().toLowerCase();
  let visibleCount = 0;
  for (const option of control.options.values()) {
    const matches = query.length === 0 || option.searchText.includes(query);
    option.button.hidden = !matches;
    if (matches) visibleCount += 1;
  }
  control.searchEmpty.hidden = query.length === 0 || visibleCount > 0;
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
  // The Model submenu is a separate top-layer popover appended to the document,
  // so an `auto` popover here would light-dismiss whenever the search input or
  // a model option inside that submenu receives a pointer. Dismissal is handled
  // manually (onDocumentPointerDown / onDocumentKeyDown) instead.
  menu.setAttribute("popover", "manual");
  menu.className = MENU_CLASSES;
  menu.style.position = "fixed";
  menu.style.inset = "auto";
  menu.style.margin = "0";
  menu.style.padding = "4px";
  menu.style.border = "0";
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
  modelMenu.dataset.codexhostModelScrollable = "true";
  ensureModelScrollbarStyle(document);
  modelMenu.style.position = "fixed";
  modelMenu.style.inset = "auto";
  modelMenu.style.margin = "0";
  modelMenu.style.padding = "4px";
  modelMenu.style.border = "0";
  modelMenu.style.maxHeight = "min(360px, 60vh)";
  modelMenu.style.overflowY = "auto";
  modelButton.setAttribute("aria-controls", modelMenu.id);

  const options = new Map<string, ModelOptionControl>();
  const thinkingOptions = new Map<string, ThinkingOptionControl>();
  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.placeholder = "Search models";
  searchInput.setAttribute("aria-label", "Search models");
  searchInput.autocomplete = "off";
  searchInput.spellcheck = false;
  searchInput.className = SEARCH_INPUT_CLASSES;
  const searchHeader = document.createElement("div");
  searchHeader.style.position = "sticky";
  searchHeader.style.top = "0";
  searchHeader.style.zIndex = "2";
  searchHeader.style.margin = "-4px";
  searchHeader.style.padding = "4px";
  searchHeader.style.backgroundColor = "Canvas";
  const searchEmpty = document.createElement("div");
  searchEmpty.dataset.codexhostModelSearchEmpty = "true";
  searchEmpty.textContent = "No matching models";
  searchEmpty.className = "block px-2 py-2 text-sm text-token-text-tertiary";
  searchEmpty.hidden = true;
  const onSearchInput = (): void => applyModelSearchFilter(control);
  searchInput.addEventListener("input", onSearchInput);
  // The search box lives in an injected popover. The harness's global keydown
  // and focus handling must never see keystrokes typed here, or it refocuses
  // the composer and yanks the cursor out of the box. Silence these events at
  // the input so they do not bubble to the harness (React event delegation).
  const silencedEventTypes = [
    "keydown",
    "keypress",
    "keyup",
    "beforeinput",
    "input",
    "compositionstart",
    "compositionupdate",
    "compositionend",
    "change",
  ] as const;
  const silenceForHarness = (event: Event): void => {
    event.stopPropagation();
  };
  for (const type of silencedEventTypes) {
    searchInput.addEventListener(type, silenceForHarness);
  }
  // Safety net: if the harness still manages to steal focus to the composer
  // (e.g. via an earlier capture-phase listener), pull the cursor back into the
  // search box as long as the submenu remains open.
  const onSearchBlur = (): void => {
    if (!popoverOpen(modelMenu)) return;
    const active = document.activeElement;
    const movedToComposer =
      active === document.body ||
      (active instanceof Element &&
        (active.matches('textarea, [contenteditable="true"], [role="textbox"]') ||
          active.closest('textarea, [contenteditable="true"], [role="textbox"]') !== null));
    if (!movedToComposer) return;
    requestAnimationFrame(() => {
      if (popoverOpen(modelMenu) && searchInput.isConnected) searchInput.focus();
    });
  };
  searchInput.addEventListener("blur", onSearchBlur);
  const closeModelMenu = (): void => {
    if (popoverOpen(modelMenu)) modelMenu.hidePopover();
    modelButton.setAttribute("aria-expanded", "false");
    if (searchInput.value !== "") {
      searchInput.value = "";
      applyModelSearchFilter(control);
    }
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
    menu.showPopover();
    positionMainMenu(control);
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
      control.searchInput.focus();
      return;
    }
    if (target?.dataset.thinkingOptionId) {
      close();
      trigger.focus();
      onSelectThinking(target.dataset.thinkingOptionId);
    }
  };
  const onModelMenuClick = (event: MouseEvent): void => {
    const target =
      event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>("button[data-model-id]")
        : null;
    if (!target?.dataset.modelId) return;
    close();
    trigger.focus();
    onSelectModel(target.dataset.modelId);
  };
  const onModelHover = (): void => openModelMenu();
  const onDocumentPointerDown = (event: PointerEvent): void => {
    if (!popoverOpen(menu) && !popoverOpen(modelMenu)) return;
    const target = event.target instanceof Node ? event.target : null;
    if (target && (root.contains(target) || menu.contains(target) || modelMenu.contains(target))) {
      return;
    }
    close();
  };
  const onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    if (!popoverOpen(menu) && !popoverOpen(modelMenu)) return;
    event.preventDefault();
    close();
    trigger.focus();
  };
  const onViewportChange = (): void => {
    if (popoverOpen(menu)) positionMainMenu(control);
    if (popoverOpen(modelMenu)) positionModelMenu(control);
  };
  trigger.addEventListener("click", onTriggerClick);
  menu.addEventListener("toggle", onToggle);
  modelMenu.addEventListener("toggle", onModelToggle);
  modelButton.addEventListener("mouseenter", onModelHover);
  root.addEventListener("click", onRootClick);
  modelMenu.addEventListener("click", onModelMenuClick);
  document.addEventListener("pointerdown", onDocumentPointerDown, true);
  document.addEventListener("keydown", onDocumentKeyDown, true);
  window.addEventListener("resize", onViewportChange);
  window.addEventListener("scroll", onViewportChange, true);
  root.append(trigger, menu);
  document.body.append(modelMenu);
  searchHeader.append(searchInput);
  modelMenu.append(searchHeader, searchEmpty);

  const control: RendererModelPickerControl = {
    root,
    trigger,
    label,
    thinkingLabel,
    menu,
    modelMenu,
    modelButton,
    searchInput,
    searchHeader,
    searchEmpty,
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
      modelMenu.removeEventListener("click", onModelMenuClick);
      searchInput.removeEventListener("input", onSearchInput);
      for (const type of silencedEventTypes) {
        searchInput.removeEventListener(type, silenceForHarness);
      }
      searchInput.removeEventListener("blur", onSearchBlur);
      document.removeEventListener("pointerdown", onDocumentPointerDown, true);
      document.removeEventListener("keydown", onDocumentKeyDown, true);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
      modelMenu.remove();
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
  control.modelMenu.replaceChildren(
    createHeading("Model"),
    control.searchHeader,
    control.searchEmpty,
  );

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
    control.options.set(model.ref.id, {
      button,
      check,
      searchText: `${model.label} ${model.ref.id}`.toLowerCase(),
    });
    control.modelMenu.append(button);
  }
  applyModelSearchFilter(control);
  // rebuildOptions replaced the submenu children above, which moves the focused
  // search input out and back in and therefore drops focus; restore it while
  // the submenu stays open.
  if (popoverOpen(control.modelMenu)) control.searchInput.focus();
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
  // While the popover is open and the picker passes through a transient state
  // (conversation target rebind or catalog reload during turn renders), keep the
  // already-rendered menu stable: do not rebuild it to an empty list or
  // force-close it under the pointer. It refreshes once a real catalog returns.
  const keepOpenMenu = popoverOpen(control.menu) && isTransientPickerState(view);
  if (control.root.dataset.catalogSignature !== catalogSignature && !keepOpenMenu) {
    rebuildOptions(control, view);
    control.root.dataset.catalogSignature = catalogSignature;
  }

  syncRendererLabelText(control.label, presentation.modelLabel);
  control.label.title = presentation.modelLabel;
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
  if (shouldCloseRendererModelPicker(view) && !keepOpenMenu) control.close();
  control.modelButton.disabled = control.trigger.disabled;
  // The search input must not mirror the trigger's disabled state: disabling a
  // focused element blurs it, which would drop the cursor out of the box during
  // transient states (e.g. "selecting"). Filtering is client-side and safe.

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
