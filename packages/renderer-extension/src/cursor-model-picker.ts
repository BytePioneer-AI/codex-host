import type { HarnessModelCatalog, HarnessModelRef } from "@codexhost/shared-contracts";

import { thinkingOptionsForModel, type RendererModelControlView } from "./renderer-model-picker.js";
import {
  ensureRendererTriggerChipStyle,
  TRIGGER_CHIP_CLASS,
} from "./renderer-trigger-chip-style.js";

const MENU_CLASSES =
  "overflow-hidden rounded-xl bg-token-dropdown-background/90 text-token-foreground shadow-lg backdrop-blur-xl";
const OPTION_CLASSES =
  "flex w-full cursor-interaction items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-token-foreground outline-none enabled:hover:bg-token-list-hover-background enabled:active:bg-token-foreground/15 disabled:cursor-not-allowed disabled:opacity-40";
const SEARCH_INPUT_CLASSES =
  "mb-1 w-full shrink-0 rounded-lg border border-token-border bg-token-dropdown-background/95 px-2 py-1.5 text-sm text-token-foreground outline-none placeholder:text-token-text-tertiary disabled:cursor-not-allowed disabled:opacity-40";
const FAST_GROUP_ID = "fast";
const GROUPED_PREFIX = "g.";
const STYLE_ATTRIBUTE = "data-codexhost-cursor-picker-style";
const HIDDEN_MODELS_KEY = "codexhost.cursor-model-picker-hidden.v1";
const SIDE_MENU_WIDTH = 320;
const SIDE_MENU_MAX_HEIGHT = 480;
const COLLISION_PADDING = 8;
const MENU_GAP = 4;

interface GroupedSelection {
  groupId: string;
  optionId: string;
}

export interface CursorThinkingGroup {
  id: string;
  label: string;
  options: Array<{ id: string; label: string }>;
  selectedOptionId?: string;
}

export interface CursorModelPickerControl {
  root: HTMLElement;
  trigger: HTMLButtonElement;
  close(): void;
  dispose(): void;
}

function encodeGroupedId(selections: readonly GroupedSelection[]): string {
  const sorted = [...selections].sort((left, right) => left.groupId.localeCompare(right.groupId));
  return `${GROUPED_PREFIX}${sorted
    .map((selection) => `${selection.groupId}~${selection.optionId}`)
    .join(".")}`;
}

function decodeGroupedId(id: string): GroupedSelection[] | null {
  if (!id.startsWith(GROUPED_PREFIX)) return null;
  const body = id.slice(GROUPED_PREFIX.length);
  if (!body) return null;
  const selections: GroupedSelection[] = [];
  for (const part of body.split(".")) {
    const separator = part.indexOf("~");
    if (separator <= 0 || separator === part.length - 1) return null;
    selections.push({ groupId: part.slice(0, separator), optionId: part.slice(separator + 1) });
  }
  try {
    if (encodeGroupedId(selections) !== id) return null;
  } catch {
    return null;
  }
  return selections;
}

export function replaceGroupedSelection(
  currentId: string | undefined,
  groupId: string,
  optionId: string,
  supportedIds: readonly string[],
): string | undefined {
  const current = currentId ? decodeGroupedId(currentId) : null;
  if (current) {
    const next = current.some((selection) => selection.groupId === groupId)
      ? current.map((selection) =>
          selection.groupId === groupId ? { groupId, optionId } : selection,
        )
      : [...current, { groupId, optionId }];
    const encoded = encodeGroupedId(next);
    if (supportedIds.includes(encoded)) return encoded;
  }
  return supportedIds.find((id) =>
    decodeGroupedId(id)?.some(
      (selection) => selection.groupId === groupId && selection.optionId === optionId,
    ),
  );
}

export function resolveSupportedThinkingOptionId(
  requested: string,
  supportedIds: readonly string[] | undefined,
): string | undefined {
  if (!supportedIds?.length) return undefined;
  if (supportedIds.includes(requested)) return requested;
  const decoded = decodeGroupedId(requested);
  if (!decoded) return undefined;
  for (const atom of decoded) {
    const resolved = replaceGroupedSelection(requested, atom.groupId, atom.optionId, supportedIds);
    if (resolved) return resolved;
  }
  return undefined;
}

function titleCase(value: string): string {
  if (value === "1m") return "1M";
  if (value === "272k") return "272K";
  if (value === "300k") return "300K";
  if (value === "xhigh") return "Extra High";
  return `${value.charAt(0)?.toUpperCase() ?? ""}${value.slice(1).replaceAll("_", " ")}`;
}

function readHiddenIds(): Set<string> {
  try {
    const raw = window.localStorage.getItem(HIDDEN_MODELS_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((id): id is string => typeof id === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

function thinkingGroupsForModel(
  catalog: HarnessModelCatalog | undefined,
  selected: HarnessModelRef | undefined,
  selectedThinkingOptionId?: string,
): CursorThinkingGroup[] {
  const present = new Map<string, Set<string>>();
  for (const option of thinkingOptionsForModel(catalog, selected)) {
    const decoded = decodeGroupedId(option.id);
    if (!decoded) return [];
    for (const selection of decoded) {
      const atoms = present.get(selection.groupId) ?? new Set<string>();
      atoms.add(selection.optionId);
      present.set(selection.groupId, atoms);
    }
  }
  if (present.size === 0) return [];
  const selectedAtoms = new Map(
    (selectedThinkingOptionId ? decodeGroupedId(selectedThinkingOptionId) : null)?.map(
      (selection) => [selection.groupId, selection.optionId],
    ) ?? [],
  );
  return [...present.entries()].map(([id, atoms]) => {
    const selectedOptionId = selectedAtoms.get(id);
    return {
      id,
      label: titleCase(id),
      options: [...atoms].map((optionId) => ({ id: optionId, label: titleCase(optionId) })),
      ...(selectedOptionId ? { selectedOptionId } : {}),
    };
  });
}

export function cursorModelPickerPresentation(view: RendererModelControlView): {
  modelLabel: string;
  thinkingLabel?: string;
  groups: CursorThinkingGroup[];
  fast?: { enabled: boolean; nextThinkingOptionId: string };
} {
  const selectedModel = view.catalog?.models.find((model) => model.ref.id === view.selected?.id);
  const groups = thinkingGroupsForModel(view.catalog, view.selected, view.selectedThinkingOptionId);
  const supported = thinkingOptionsForModel(view.catalog, view.selected).map((option) => option.id);
  const on = replaceGroupedSelection(
    view.selectedThinkingOptionId,
    FAST_GROUP_ID,
    "true",
    supported,
  );
  const off = replaceGroupedSelection(
    view.selectedThinkingOptionId,
    FAST_GROUP_ID,
    "false",
    supported,
  );
  const fast =
    on && off && on !== off
      ? {
          enabled: Boolean(
            decodeGroupedId(view.selectedThinkingOptionId ?? "")?.some(
              (selection) => selection.groupId === FAST_GROUP_ID && selection.optionId === "true",
            ),
          ),
          nextThinkingOptionId: decodeGroupedId(view.selectedThinkingOptionId ?? "")?.some(
            (selection) => selection.groupId === FAST_GROUP_ID && selection.optionId === "true",
          )
            ? off
            : on,
        }
      : undefined;
  const thinkingGroups = groups.filter((group) => group.id !== FAST_GROUP_ID);
  const thinkingLabel = thinkingGroups
    .map((group) => group.options.find((option) => option.id === group.selectedOptionId)?.label)
    .filter((label): label is string => Boolean(label) && label !== "Off")
    .join(" · ");
  return {
    modelLabel: selectedModel?.label ?? "Select model",
    ...(thinkingLabel ? { thinkingLabel } : {}),
    groups: thinkingGroups,
    ...(fast ? { fast } : {}),
  };
}

function ensureCursorPickerStyle(ownerDocument: Document): void {
  if (ownerDocument.querySelector(`style[${STYLE_ATTRIBUTE}]`)) return;
  const style = ownerDocument.createElement("style");
  style.setAttribute(STYLE_ATTRIBUTE, "true");
  style.textContent = `
    .codexhost-switch {
      position: relative;
      display: inline-block;
      flex: none;
      width: 36px;
      height: 20px;
      padding: 0;
      border: 0;
      border-radius: 999px;
      background: rgba(127, 127, 127, 0.28);
      pointer-events: none;
    }
    .codexhost-switch[data-checked="true"] {
      background: #16a34a;
    }
    .codexhost-switch::after {
      content: "";
      position: absolute;
      top: 2px;
      left: 2px;
      width: 16px;
      height: 16px;
      border-radius: 999px;
      background: #fff;
    }
    .codexhost-switch[data-checked="true"]::after {
      left: 18px;
    }
  `;
  (ownerDocument.head ?? ownerDocument.documentElement).append(style);
}

function popoverOpen(menu: HTMLElement): boolean {
  return menu.matches(":popover-open");
}

function createCheck(): HTMLElement {
  const check = document.createElement("span");
  check.textContent = "\u2713";
  check.setAttribute("aria-hidden", "true");
  check.style.width = "16px";
  check.style.flex = "none";
  return check;
}

function createChevron(): HTMLElement {
  const chevron = document.createElement("span");
  chevron.textContent = "\u203a";
  chevron.setAttribute("aria-hidden", "true");
  chevron.className = "shrink-0 text-token-text-tertiary";
  return chevron;
}

function createCompactRow(label: string, value?: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("role", "menuitem");
  button.className = OPTION_CLASSES;
  const title = document.createElement("span");
  title.textContent = label;
  title.className = "min-w-0 flex-1 truncate text-left";
  button.append(title);
  if (value) {
    const detail = document.createElement("span");
    detail.textContent = value;
    detail.className = "shrink-0 text-token-text-tertiary";
    button.append(detail);
  }
  button.append(createChevron());
  return button;
}

function placeSidePanel(
  panel: HTMLElement,
  main: HTMLElement,
  maxHeightCap = SIDE_MENU_MAX_HEIGHT,
): void {
  const mainRect = main.getBoundingClientRect();
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const preferredWidth = Math.min(
    SIDE_MENU_WIDTH,
    Math.max(COLLISION_PADDING, viewport.width - 16),
  );
  const rightLeft = mainRect.right + MENU_GAP;
  const leftLeft = mainRect.left - MENU_GAP - preferredWidth;
  const rightAvailable = viewport.width - rightLeft - COLLISION_PADDING;
  const leftAvailable = mainRect.left - MENU_GAP - COLLISION_PADDING;
  let width = preferredWidth;
  let left = rightLeft;
  if (rightAvailable < preferredWidth && leftAvailable >= preferredWidth) {
    left = leftLeft;
  } else if (rightAvailable < preferredWidth && leftAvailable < preferredWidth) {
    if (rightAvailable >= leftAvailable) {
      width = Math.max(COLLISION_PADDING, rightAvailable);
      left = rightLeft;
    } else {
      width = Math.max(COLLISION_PADDING, leftAvailable);
      left = mainRect.left - MENU_GAP - width;
    }
  }
  const bottom = Math.max(COLLISION_PADDING, viewport.height - mainRect.bottom);
  const maxHeight = Math.max(
    COLLISION_PADDING,
    Math.min(maxHeightCap, viewport.height * 0.7, mainRect.bottom - COLLISION_PADDING),
  );
  panel.style.position = "fixed";
  panel.style.left = `${Math.max(COLLISION_PADDING, left)}px`;
  panel.style.width = `${width}px`;
  panel.style.maxWidth = `${width}px`;
  panel.style.top = "auto";
  panel.style.bottom = `${bottom}px`;
  panel.style.maxHeight = `${maxHeight}px`;
}

export function mountCursorModelPicker(
  composerId: string,
  onSelectModel: (modelId: string) => void,
  onSelectThinking: (thinkingOptionId: string) => void,
): CursorModelPickerControl {
  ensureRendererTriggerChipStyle(document);
  ensureCursorPickerStyle(document);

  const root = document.createElement("div");
  root.setAttribute("data-codexhost-cursor-model-control", composerId);
  root.className = "relative min-w-0";
  root.style.display = "none";
  root.style.alignItems = "center";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = TRIGGER_CHIP_CLASS;
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  trigger.style.height = "28px";
  trigger.style.padding = "0 8px";
  trigger.style.gap = "6px";
  trigger.style.font = "400 13px/18px system-ui, sans-serif";
  trigger.style.maxWidth = "min(240px, 32vw)";
  const label = document.createElement("span");
  label.style.minWidth = "0";
  label.style.overflow = "hidden";
  label.style.textOverflow = "ellipsis";
  const thinkingLabel = document.createElement("span");
  thinkingLabel.className = "text-token-text-tertiary";
  thinkingLabel.style.minWidth = "0";
  thinkingLabel.style.overflow = "hidden";
  thinkingLabel.style.textOverflow = "ellipsis";
  thinkingLabel.hidden = true;
  trigger.append(label, thinkingLabel);

  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Cursor model");
  menu.setAttribute("popover", "manual");
  menu.className = "fixed z-50";
  menu.style.position = "fixed";
  menu.style.inset = "auto";
  menu.style.margin = "0";

  const card = document.createElement("div");
  card.className = MENU_CLASSES;
  card.style.padding = "4px";
  card.style.border = "0";
  card.style.minWidth = "220px";
  card.style.font = "400 13px/18px system-ui, sans-serif";

  const thinkingMenu = document.createElement("div");
  thinkingMenu.setAttribute("role", "menu");
  thinkingMenu.hidden = true;
  thinkingMenu.className = MENU_CLASSES;
  thinkingMenu.style.position = "fixed";
  thinkingMenu.style.padding = "4px";
  thinkingMenu.style.border = "0";
  thinkingMenu.style.font = "400 13px/18px system-ui, sans-serif";

  const modelMenu = document.createElement("div");
  modelMenu.setAttribute("role", "menu");
  modelMenu.hidden = true;
  modelMenu.className = MENU_CLASSES;
  modelMenu.style.position = "fixed";
  modelMenu.style.padding = "0";
  modelMenu.style.border = "0";
  modelMenu.style.flexDirection = "column";
  modelMenu.style.overflow = "hidden";
  modelMenu.style.font = "400 13px/18px system-ui, sans-serif";

  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.placeholder = "Search models";
  searchInput.setAttribute("aria-label", "Search models");
  searchInput.className = SEARCH_INPUT_CLASSES;
  const searchHeader = document.createElement("div");
  searchHeader.style.flex = "none";
  searchHeader.style.padding = "8px 8px 4px";
  searchHeader.append(searchInput);
  const searchEmpty = document.createElement("div");
  searchEmpty.textContent = "No matching models";
  searchEmpty.className = "px-2 py-2 text-sm text-token-text-tertiary";
  searchEmpty.hidden = true;
  const optionsList = document.createElement("div");
  optionsList.style.flex = "1 1 auto";
  optionsList.style.minHeight = "0";
  optionsList.style.overflowY = "auto";
  optionsList.style.padding = "4px";
  modelMenu.append(searchHeader, optionsList);

  const options = new Map<string, { button: HTMLButtonElement; searchText: string }>();
  const thinkingButtons = new Map<string, HTMLButtonElement>();
  let lastView: RendererModelControlView = { status: "idle" };

  const showSide = (panel: HTMLElement): void => {
    panel.hidden = false;
    panel.style.display = "flex";
  };
  const hideSide = (panel: HTMLElement): void => {
    panel.hidden = true;
  };
  const closeSides = (): void => {
    hideSide(thinkingMenu);
    hideSide(modelMenu);
  };
  const close = (): void => {
    closeSides();
    if (popoverOpen(menu)) menu.hidePopover();
    trigger.setAttribute("aria-expanded", "false");
  };
  const keepEntryOpen = (): boolean => {
    if (!popoverOpen(menu)) menu.showPopover();
    placeMain();
    return popoverOpen(menu);
  };
  const placeMain = (): void => {
    const rect = trigger.getBoundingClientRect();
    const width = 240;
    menu.style.width = `${width}px`;
    menu.style.left = `${Math.max(COLLISION_PADDING, rect.right - width)}px`;
    menu.style.top = "auto";
    menu.style.bottom = `${Math.max(COLLISION_PADDING, window.innerHeight - rect.top + MENU_GAP)}px`;
  };

  const rebuild = (view: RendererModelControlView): void => {
    const presentation = cursorModelPickerPresentation(view);
    const supported = thinkingOptionsForModel(view.catalog, view.selected).map(
      (option) => option.id,
    );
    card.replaceChildren();
    thinkingButtons.clear();
    options.clear();
    optionsList.replaceChildren(searchEmpty);

    if (presentation.fast) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = OPTION_CLASSES;
      row.setAttribute("role", "switch");
      row.dataset.nextThinking = presentation.fast.nextThinkingOptionId;
      row.setAttribute("aria-checked", String(presentation.fast.enabled));
      const title = document.createElement("span");
      title.textContent = "Fast";
      title.style.flex = "1";
      const knob = document.createElement("span");
      knob.className = "codexhost-switch";
      knob.dataset.checked = String(presentation.fast.enabled);
      knob.setAttribute("aria-hidden", "true");
      row.append(title, knob);
      card.append(row);
    }
    for (const group of presentation.groups) {
      const selected =
        group.options.find((option) => option.id === group.selectedOptionId)?.label ?? "";
      const row = createCompactRow(group.label, selected);
      row.dataset.openGroup = group.id;
      card.append(row);
      for (const option of group.options) {
        const cartesianId = replaceGroupedSelection(
          view.selectedThinkingOptionId,
          group.id,
          option.id,
          supported,
        );
        if (!cartesianId) continue;
        const button = document.createElement("button");
        button.type = "button";
        button.className = OPTION_CLASSES;
        button.dataset.thinkingOptionId = cartesianId;
        button.dataset.groupId = group.id;
        const text = document.createElement("span");
        text.textContent = option.label;
        text.style.flex = "1";
        const check = createCheck();
        check.style.visibility = option.id === group.selectedOptionId ? "visible" : "hidden";
        button.append(text, check);
        thinkingButtons.set(`${group.id}:${option.id}`, button);
      }
    }
    const modelRow = createCompactRow("Model", presentation.modelLabel);
    modelRow.dataset.openModels = "true";
    card.append(modelRow);

    const hidden = readHiddenIds();
    const selectedId = view.selected?.id;
    for (const model of view.catalog?.models ?? []) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = OPTION_CLASSES;
      button.dataset.modelId = model.ref.id;
      button.dataset.modelLabel = model.label;
      button.hidden = hidden.has(model.ref.id) && model.ref.id !== selectedId;
      const text = document.createElement("span");
      text.textContent = model.label;
      text.style.flex = "1";
      text.style.minWidth = "0";
      text.style.overflow = "hidden";
      text.style.textOverflow = "ellipsis";
      const check = createCheck();
      check.style.visibility = model.ref.id === selectedId ? "visible" : "hidden";
      button.append(text, check);
      options.set(model.ref.id, {
        button,
        searchText: `${model.label} ${model.ref.id}`.toLowerCase(),
      });
      optionsList.append(button);
    }
  };

  const openGroup = (groupId: string): void => {
    if (!keepEntryOpen()) return;
    hideSide(modelMenu);
    thinkingMenu.replaceChildren();
    for (const [key, button] of thinkingButtons) {
      if (key.startsWith(`${groupId}:`)) thinkingMenu.append(button);
    }
    showSide(thinkingMenu);
    thinkingMenu.style.display = "block";
    placeSidePanel(thinkingMenu, card);
  };
  const openModels = (): void => {
    if (!keepEntryOpen()) return;
    hideSide(thinkingMenu);
    showSide(modelMenu);
    placeSidePanel(modelMenu, card);
    searchInput.focus();
  };

  const onTriggerClick = (): void => {
    if (popoverOpen(menu) || !thinkingMenu.hidden || !modelMenu.hidden) {
      close();
      return;
    }
    rebuild(lastView);
    menu.showPopover();
    trigger.setAttribute("aria-expanded", "true");
    placeMain();
  };
  const onMenuClick = (event: MouseEvent): void => {
    const target =
      event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button") : null;
    if (target?.dataset.openGroup) {
      openGroup(target.dataset.openGroup);
      return;
    }
    if (target?.dataset.openModels) {
      openModels();
      return;
    }
    if (target?.dataset.nextThinking) {
      onSelectThinking(target.dataset.nextThinking);
      return;
    }
    if (target?.dataset.thinkingOptionId) {
      onSelectThinking(target.dataset.thinkingOptionId);
    }
  };
  const onModelMenuClick = (event: MouseEvent): void => {
    const target =
      event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button") : null;
    if (!target?.dataset.modelId) return;
    hideSide(modelMenu);
    onSelectModel(target.dataset.modelId);
  };
  const onSearch = (): void => {
    const query = searchInput.value.trim().toLowerCase();
    const hidden = readHiddenIds();
    let visible = 0;
    for (const [id, option] of options) {
      const hiddenByPref = hidden.has(id) && id !== lastView.selected?.id;
      const matches = query.length === 0 || option.searchText.includes(query);
      option.button.hidden = hiddenByPref || !matches;
      if (!option.button.hidden) visible += 1;
    }
    searchEmpty.hidden = visible > 0;
  };
  const onDocumentPointerDown = (event: PointerEvent): void => {
    const target = event.target instanceof Node ? event.target : null;
    if (
      target &&
      (root.contains(target) ||
        menu.contains(target) ||
        thinkingMenu.contains(target) ||
        modelMenu.contains(target))
    ) {
      return;
    }
    close();
  };
  const onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    close();
    trigger.focus();
  };
  const onToggle = (): void => {
    trigger.setAttribute("aria-expanded", String(popoverOpen(menu)));
    if (!popoverOpen(menu)) closeSides();
  };
  const onViewportChange = (): void => {
    if (!popoverOpen(menu)) {
      close();
      return;
    }
    placeMain();
    if (!thinkingMenu.hidden) placeSidePanel(thinkingMenu, card);
    if (!modelMenu.hidden) placeSidePanel(modelMenu, card);
  };

  trigger.addEventListener("click", onTriggerClick);
  menu.addEventListener("toggle", onToggle);
  menu.addEventListener("click", onMenuClick);
  thinkingMenu.addEventListener("click", onMenuClick);
  modelMenu.addEventListener("click", onModelMenuClick);
  searchInput.addEventListener("input", onSearch);
  document.addEventListener("pointerdown", onDocumentPointerDown, true);
  document.addEventListener("keydown", onDocumentKeyDown, true);
  window.addEventListener("resize", onViewportChange);
  window.addEventListener("scroll", onViewportChange, true);
  root.append(trigger);
  menu.append(card, thinkingMenu, modelMenu);
  document.body.append(menu);

  const control: CursorModelPickerControl & { render(view: RendererModelControlView): void } = {
    root,
    trigger,
    close,
    render(view: RendererModelControlView) {
      lastView = view;
      const presentation = cursorModelPickerPresentation(view);
      label.textContent = presentation.modelLabel;
      const secondary = [
        presentation.thinkingLabel,
        presentation.fast?.enabled ? "Fast" : undefined,
      ]
        .filter(Boolean)
        .join(" · ");
      thinkingLabel.textContent = secondary;
      thinkingLabel.hidden = secondary.length === 0;
      trigger.title = [presentation.modelLabel, secondary].filter(Boolean).join(", ");
      if (popoverOpen(menu)) rebuild(view);
    },
    dispose() {
      close();
      trigger.removeEventListener("click", onTriggerClick);
      menu.removeEventListener("toggle", onToggle);
      menu.removeEventListener("click", onMenuClick);
      thinkingMenu.removeEventListener("click", onMenuClick);
      modelMenu.removeEventListener("click", onModelMenuClick);
      searchInput.removeEventListener("input", onSearch);
      document.removeEventListener("pointerdown", onDocumentPointerDown, true);
      document.removeEventListener("keydown", onDocumentKeyDown, true);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
      menu.remove();
      root.remove();
    },
  };
  return control;
}

export function renderCursorModelPicker(
  control: CursorModelPickerControl & { render?: (view: RendererModelControlView) => void },
  view: RendererModelControlView,
  visible: boolean,
): void {
  control.root.style.display = visible ? "inline-flex" : "none";
  if (!visible) {
    control.close();
    return;
  }
  control.render?.(view);
}
