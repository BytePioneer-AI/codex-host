import type { HarnessCommandDescriptor } from "@codexhost/shared-contracts";

import {
  rendererHarnessCommandPresentation,
  rendererHarnessMessages,
} from "./renderer-harness-localization.js";
import type { RendererSettingsLocale } from "./settings/localization.js";

const CONTROL_ATTRIBUTE = "data-codexhost-harness-skill-control";
const MENU_ATTRIBUTE = "data-codexhost-harness-skill-menu";
const ARGUMENT_INPUT_ATTRIBUTE = "data-codexhost-harness-skill-argument";
const MENU_WIDTH = 320;
const VIEWPORT_MARGIN = 8;
const MENU_GAP = 8;
const SVG_NS = "http://www.w3.org/2000/svg";
// Distinct glyph: the rounded-frame path from the Harness command icon set,
// drawn alone instead of with the command grid overlay.
const SKILL_ICON_PATHS = [
  "M640 970.666667H384c-118.186667 0-198.272-25.002667-251.946667-78.72S53.333333 758.186667 53.333333 640V384c0-118.186667 25.002667-198.272 78.72-251.946667S265.813333 53.333333 384 53.333333h256c118.186667 0 198.272 25.002667 251.946667 78.72S970.666667 265.813333 970.666667 384v256c0 118.186667-25.002667 198.272-78.72 251.946667S758.186667 970.666667 640 970.666667z m-256-853.333334c-100.096 0-165.802667 19.2-206.72 59.946667S117.333333 283.904 117.333333 384v256c0 100.096 19.072 165.802667 59.946667 206.72S283.904 906.666667 384 906.666667h256c100.096 0 165.802667-19.072 206.72-59.946667S906.666667 740.096 906.666667 640V384c0-100.096-19.072-165.802667-59.946667-206.72S740.096 117.333333 640 117.333333z",
];

function skillIcon(ownerDocument: Document): SVGSVGElement {
  const svg = ownerDocument.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 1024 1024");
  svg.setAttribute("width", "15");
  svg.setAttribute("height", "15");
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("aria-hidden", "true");
  for (const path of SKILL_ICON_PATHS) {
    const element = ownerDocument.createElementNS(SVG_NS, "path");
    element.setAttribute("d", path);
    svg.append(element);
  }
  return svg;
}

export interface RendererHarnessSkillControl {
  readonly root: HTMLElement;
  setSkills(skills: readonly HarnessCommandDescriptor[]): void;
  setExecuting(commandId: string | null): void;
  setLocale(locale: RendererSettingsLocale): void;
  placeBefore(reference: Element | null): boolean;
  open(): void;
  hasSkills(): boolean;
  close(): void;
  dispose(): void;
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

function textInputStyle(input: HTMLInputElement): void {
  input.style.display = "block";
  input.style.width = "100%";
  input.style.boxSizing = "border-box";
  input.style.padding = "6px";
  input.style.border = "0";
  input.style.borderRadius = "6px";
  input.style.background = "rgba(127, 127, 127, 0.08)";
  input.style.color = "inherit";
  input.style.font = "13px/18px system-ui, sans-serif";
  input.style.outline = "none";
}

export function mountRendererHarnessSkillControl(
  parent: Element,
  insertBefore: Element | null,
  onSelectSkill: (skill: HarnessCommandDescriptor, argument: string | undefined) => void,
  initialLocale: RendererSettingsLocale = "en",
): RendererHarnessSkillControl {
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
  trigger.setAttribute("aria-label", messages.skills);
  trigger.title = messages.skills;
  setButtonClass(trigger);
  trigger.append(skillIcon(ownerDocument));
  root.append(trigger);

  const menu = ownerDocument.createElement("div");
  menu.setAttribute(MENU_ATTRIBUTE, "true");
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", messages.skills);
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

  let skills: readonly HarnessCommandDescriptor[] = [];
  let items: HTMLButtonElement[] = [];
  let activeIndex = 0;
  let filterTerm = "";
  let executingSkillId: string | null = null;
  let triggerHovered = false;
  let disposed = false;
  let argumentSkill: HarnessCommandDescriptor | null = null;
  let filterInput: HTMLInputElement | null = null;
  let argumentInput: HTMLInputElement | null = null;

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
    argumentSkill = null;
    filterTerm = "";
    trigger.setAttribute("aria-expanded", "false");
    syncTriggerBackground();
  };

  let openInternal: (shouldFocus: boolean) => void = () => undefined;

  const select = (skill: HarnessCommandDescriptor, argument: string | undefined): void => {
    close();
    onSelectSkill(skill, argument);
  };

  const matchesFilter = (skill: HarnessCommandDescriptor): boolean => {
    const term = filterTerm.toLowerCase();
    if (term === "") return true;
    const presentation = rendererHarnessCommandPresentation(skill, locale);
    return `${skill.invocation} ${presentation.label} ${presentation.description}`
      .toLowerCase()
      .includes(term);
  };

  const menuItem = (skill: HarnessCommandDescriptor): HTMLButtonElement => {
    const presentation = rendererHarnessCommandPresentation(skill, locale);
    const item = ownerDocument.createElement("button");
    item.type = "button";
    item.setAttribute("role", "menuitem");
    item.setAttribute("data-skill-id", skill.id);
    item.setAttribute("aria-label", `${skill.invocation} ${presentation.label}`);
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
    item.addEventListener("click", () => {
      if (skill.argumentMode === "text") showArgumentPhase(skill);
      else select(skill, undefined);
    });

    const copy = ownerDocument.createElement("span");
    copy.style.display = "flex";
    copy.style.flexDirection = "column";
    copy.style.minWidth = "0";
    copy.style.flex = "1 1 auto";

    const title = ownerDocument.createElement("span");
    title.textContent = skill.invocation;
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
    hint.textContent = skill.argumentMode === "text" ? messages.textArgument : "↵";
    hint.style.flex = "0 0 auto";
    hint.style.color = "rgba(127, 127, 127, 0.75)";
    hint.style.font = "400 11px/16px ui-monospace, SFMono-Regular, Menlo, monospace";

    copy.append(title, description);
    item.append(copy, hint);
    return item;
  };

  let listContainer: HTMLElement | null = null;

  const renderFilteredItems = (): void => {
    const container = listContainer;
    if (!container) return;
    items = skills.filter(matchesFilter).map(menuItem);
    activeIndex = clamp(activeIndex, 0, Math.max(0, items.length - 1));
    if (executingSkillId !== null) {
      for (const item of items) {
        const isExecuting = item.dataset.skillId === executingSkillId;
        item.disabled = true;
        item.style.opacity = isExecuting ? "1" : "0.5";
        if (isExecuting) item.setAttribute("aria-busy", "true");
      }
    }
    container.replaceChildren(...items);
  };

  const renderListPhase = (): void => {
    argumentSkill = null;
    const header = ownerDocument.createElement("div");
    header.style.padding = "4px";
    const filter = ownerDocument.createElement("input");
    filter.type = "text";
    filter.setAttribute("role", "searchbox");
    filter.setAttribute("aria-label", messages.filterSkills);
    filter.placeholder = messages.filterSkills;
    textInputStyle(filter);
    filter.value = filterTerm;
    filter.addEventListener("input", () => {
      filterTerm = filter.value;
      activeIndex = 0;
      renderFilteredItems();
    });
    filterInput = filter;
    header.append(filter);

    const container = ownerDocument.createElement("div");
    listContainer = container;

    menu.replaceChildren(header, container);
    renderFilteredItems();
  };

  const showArgumentPhase = (skill: HarnessCommandDescriptor): void => {
    argumentSkill = skill;
    filterInput = null;
    listContainer = null;
    items = [];

    const back = ownerDocument.createElement("button");
    back.type = "button";
    back.textContent = `← ${messages.back}`;
    back.style.border = "0";
    back.style.background = "transparent";
    back.style.color = "rgba(127, 127, 127, 0.9)";
    back.style.font = "600 11px/16px system-ui, sans-serif";
    back.style.padding = "5px 8px 2px";
    back.style.cursor = "pointer";
    back.style.textAlign = "left";
    back.addEventListener("click", () => {
      renderListPhase();
      positionMenu();
      queueMicrotask(() => filterInput?.focus());
    });

    const title = ownerDocument.createElement("div");
    title.textContent = skill.invocation;
    title.style.padding = "2px 8px 6px";
    title.style.font = "600 13px/18px system-ui, sans-serif";
    title.style.whiteSpace = "nowrap";

    const argument = ownerDocument.createElement("input");
    argument.type = "text";
    argument.setAttribute(ARGUMENT_INPUT_ATTRIBUTE, "true");
    argument.setAttribute("aria-label", skill.invocation);
    textInputStyle(argument);
    argumentInput = argument;

    menu.replaceChildren(back, title, argument);
    positionMenu();
    queueMicrotask(() => argument.focus());
  };

  const submitArgument = (): void => {
    const skill = argumentSkill;
    if (!skill) return;
    const value = (argumentInput?.value ?? "").trim();
    argumentSkill = null;
    argumentInput = null;
    select(skill, value || undefined);
  };

  const isExecutingGate = (): boolean => executingSkillId !== null;

  openInternal = (shouldFocus: boolean): void => {
    if (skills.length === 0 || isExecutingGate()) return;
    if (menu.hidden) renderListPhase();
    menu.hidden = false;
    positionMenu();
    trigger.setAttribute("aria-expanded", "true");
    syncTriggerBackground();
    if (shouldFocus) queueMicrotask(() => filterInput?.focus());
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

  const onKeyDown = (event: KeyboardEvent): void => {
    if (menu.hidden) return;
    const target = event.target;
    if (argumentSkill !== null) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        renderListPhase();
        queueMicrotask(() => filterInput?.focus());
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        submitArgument();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      const input = filterInput;
      if (input !== null && event.target === input) {
        input.blur();
        return;
      }
      close();
      trigger.focus();
      return;
    }
    // Navigation keys only act within the popover surface: focus may sit on the
    // filter input, an item, or (after blur) nowhere in the document, in which
    // case Escape above still closes.
    if (target !== filterInput && !menu.contains(target as Node)) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (items.length === 0) return;
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
  const onTriggerKeyDown = (event: KeyboardEvent): void => {
    if (menu.hidden && (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      openInternal(true);
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
    openInternal(true);
  });
  trigger.addEventListener("pointerenter", () => {
    triggerHovered = true;
    syncTriggerBackground();
    cancelClose();
    if (menu.hidden) openInternal(false);
  });
  trigger.addEventListener("pointerleave", () => {
    triggerHovered = false;
    syncTriggerBackground();
    scheduleClose();
  });
  trigger.addEventListener("keydown", onTriggerKeyDown);
  menu.addEventListener("pointerenter", cancelClose);
  menu.addEventListener("pointerleave", scheduleClose);
  ownerDocument.addEventListener("keydown", onKeyDown);
  ownerDocument.addEventListener("pointerdown", onDocumentPointerDown, true);
  ownerDocument.defaultView?.addEventListener("resize", onViewportChange);
  ownerDocument.defaultView?.addEventListener("scroll", onViewportChange, true);

  const control: RendererHarnessSkillControl = {
    root,
    placeBefore(reference) {
      if (!reference?.parentElement) return false;
      if (root.parentElement === reference.parentElement && root.nextElementSibling === reference) {
        return true;
      }
      reference.parentElement.insertBefore(root, reference);
      return true;
    },
    setSkills(nextSkills) {
      skills = [...nextSkills];
      root.hidden = skills.length === 0;
      root.style.display = skills.length === 0 ? "none" : "inline-flex";
      if (skills.length === 0) close();
      // Keep the catalog data fresh but leave the argument input DOM intact;
      // the list phase rebuilds on Escape/back or the next open.
      if (!menu.hidden && argumentSkill === null) renderListPhase();
    },
    setExecuting(commandId) {
      executingSkillId = commandId;
      for (const item of items) {
        const isExecuting = item.dataset.skillId === commandId;
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
      trigger.setAttribute("aria-label", messages.skills);
      trigger.title = messages.skills;
      menu.setAttribute("aria-label", messages.skills);
      if (!menu.hidden) {
        if (argumentSkill) showArgumentPhase(argumentSkill);
        else renderListPhase();
      }
    },
    open() {
      openInternal(true);
    },
    hasSkills() {
      return skills.length > 0;
    },
    close,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelClose();
      close();
      ownerDocument.removeEventListener("keydown", onKeyDown);
      ownerDocument.removeEventListener("pointerdown", onDocumentPointerDown, true);
      ownerDocument.defaultView?.removeEventListener("resize", onViewportChange);
      ownerDocument.defaultView?.removeEventListener("scroll", onViewportChange, true);
      trigger.removeEventListener("keydown", onTriggerKeyDown);
      menu.removeEventListener("pointerenter", cancelClose);
      menu.removeEventListener("pointerleave", scheduleClose);
      menu.remove();
      root.remove();
    },
  };

  root.hidden = true;
  root.style.display = "none";
  return control;
}
