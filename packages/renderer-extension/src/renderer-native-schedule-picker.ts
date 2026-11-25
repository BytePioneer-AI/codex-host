/** Narrow listbox picker for the native schedule dialog. HTML option elements cannot draw a
 * Harness Logo, so the codexhost selection rows use this popup instead. It owns display and keyboard
 * interaction only; selection meaning stays with the caller. */
export interface SchedulePickerItem {
  value: string;
  label: string;
  icon?: Element | null;
  disabled?: boolean;
}

export interface SchedulePicker {
  /** Shadow-DOM content: trigger button and popup. */
  readonly root: HTMLElement;
  readonly trigger: HTMLButtonElement;
  value: string;
  disabled: boolean;
  busy: boolean;
  setItems(items: readonly SchedulePickerItem[]): void;
  /** Items the caller currently refuses; they stay visible but cannot be chosen. */
  setDisabledValues(isDisabled: (value: string) => boolean): void;
  /** Shown while no item matches `value`. `shimmer` marks a stable loading placeholder. */
  setPlaceholder(text: string, shimmer?: boolean): void;
  close(): void;
}

export const schedulePickerStyles = `
  .picker { position:relative; display:flex; justify-content:flex-end; min-width:0; max-width:100%; }
  .trigger { display:flex; align-items:center; gap:8px; min-width:0; max-width:100%; height:32px; padding:0 8px 0 10px; border:0; border-radius:10px; color:var(--muted); background:transparent; font:inherit; text-align:right; cursor:pointer; transition:background-color .12s, color .12s; }
  .trigger:hover:not(:disabled), .trigger[aria-expanded="true"] { color:var(--text); background:var(--hover); }
  .trigger:focus-visible { outline:2px solid var(--focus); outline-offset:1px; }
  .trigger:disabled { cursor:default; }
  .trigger > svg, .trigger > img, .trigger > span.icon, .item > svg, .item > img, .item > span.icon { flex:none; }
  .label { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .trigger[data-stale] .label { opacity:.6; }
  .trigger[data-shimmer] .label { background:linear-gradient(90deg,var(--muted) 0%,var(--muted) 35%,color-mix(in srgb,var(--muted) 30%,transparent) 50%,var(--muted) 65%,var(--muted) 100%) 100% 0/250% 100%; -webkit-background-clip:text; background-clip:text; color:transparent; animation:shimmer 1.4s ease-in-out infinite; }
  .chevron { flex:none; width:6px; height:6px; margin:0 3px 2px 2px; border-right:1.5px solid; border-bottom:1.5px solid; transform:rotate(45deg); transition:transform .12s; }
  .trigger[aria-expanded="true"] .chevron { transform:translateY(2px) rotate(225deg); }
  .trigger[aria-busy="true"] .chevron { display:none; }
  .spinner { flex:none; width:12px; height:12px; margin:0 1px; border:1.5px solid color-mix(in srgb,currentColor 25%,transparent); border-top-color:currentColor; border-radius:50%; animation:spin .8s linear infinite; }
  .menu { position:fixed; inset:auto; margin:0; padding:4px; min-width:200px; max-width:calc(100vw - 16px); overflow:auto; overscroll-behavior:contain; border:1px solid var(--border); border-radius:12px; color:var(--text); background:var(--surface); box-shadow:0 8px 28px rgba(0,0,0,.22),0 1px 3px rgba(0,0,0,.12); font:inherit; }
  .menu:not(:popover-open):not([data-open]) { display:none; }
  .item { display:flex; align-items:center; gap:10px; min-height:36px; padding:6px 8px; border-radius:8px; cursor:pointer; outline:none; }
  .item:hover:not([aria-disabled="true"]), .item:focus-visible { background:var(--hover); }
  .item:focus-visible { box-shadow:inset 0 0 0 2px var(--focus); }
  .item[aria-disabled="true"] { opacity:.45; cursor:default; }
  .item .label { flex:1; }
  .check { flex:none; width:5px; height:9px; margin:0 6px 2px 4px; border-right:1.5px solid; border-bottom:1.5px solid; transform:rotate(45deg); visibility:hidden; }
  .item[aria-selected="true"] .check { visibility:visible; }
  @keyframes shimmer { to { background-position:-100% 0; } }
  @keyframes spin { to { transform:rotate(360deg); } }
  @media(prefers-reduced-motion:reduce) { .spinner, .trigger[data-shimmer] .label { animation:none; } .trigger, .chevron { transition:none; } }
`;

export function createSchedulePicker(
  document: Document,
  options: {
    label: string;
    listLabel: string;
    onChange(value: string): void;
    onOpen?(): void;
    /** Keep showing the selected item after it disappears from `items`. */
    retainMissing?: boolean;
  },
): SchedulePicker {
  const view = document.defaultView ?? window;
  const root = document.createElement("div");
  root.className = "picker";
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "trigger";
  trigger.setAttribute("aria-label", options.label);
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  const menu = document.createElement("div");
  menu.className = "menu";
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", options.listLabel);
  const supportsPopover = typeof menu.showPopover === "function";
  if (supportsPopover) menu.setAttribute("popover", "manual");
  root.append(trigger, menu);

  let items: readonly SchedulePickerItem[] = [];
  let stale: SchedulePickerItem | null = null;
  let value = "";
  let disabled = false;
  let busy = false;
  let placeholder = "";
  let shimmer = false;
  let isOpen = false;
  let isDisabled: (value: string) => boolean = () => false;
  const optionElements = new Map<string, HTMLElement>();

  const selectedItem = () => items.find((item) => item.value === value) ?? stale;
  const cloneIcon = (item: SchedulePickerItem) => (item.icon?.cloneNode(true) as Element) ?? null;

  const renderTrigger = () => {
    const item = selectedItem();
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = item?.label ?? placeholder;
    const icon = item ? cloneIcon(item) : null;
    const tail = document.createElement("span");
    tail.className = busy ? "spinner" : "chevron";
    tail.setAttribute("aria-hidden", "true");
    trigger.replaceChildren(...(icon ? [icon] : []), label, tail);
    trigger.toggleAttribute("data-stale", Boolean(item && !items.includes(item)));
    trigger.toggleAttribute("data-shimmer", shimmer && !item);
    trigger.dataset.value = item ? value : "";
    trigger.setAttribute("aria-busy", String(busy));
    trigger.disabled = disabled;
    if (disabled && isOpen) close();
  };

  const renderItems = () => {
    optionElements.clear();
    const elements = items.map((item) => {
      const option = document.createElement("div");
      option.className = "item";
      option.setAttribute("role", "option");
      option.tabIndex = -1;
      option.dataset.value = item.value;
      option.setAttribute("aria-selected", String(item.value === value));
      if (item.disabled || isDisabled(item.value)) option.setAttribute("aria-disabled", "true");
      const icon = cloneIcon(item);
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = item.label;
      const check = document.createElement("span");
      check.className = "check";
      check.setAttribute("aria-hidden", "true");
      option.append(...(icon ? [icon] : []), label, check);
      optionElements.set(item.value, option);
      return option;
    });
    menu.replaceChildren(...elements);
  };

  const enabledOptions = () =>
    [...optionElements.values()].filter((el) => el.getAttribute("aria-disabled") !== "true");
  const focusOption = (el: HTMLElement | undefined) => {
    el?.focus();
    el?.scrollIntoView({ block: "nearest" });
  };

  const position = () => {
    const rect = trigger.getBoundingClientRect();
    const margin = 8;
    menu.style.minWidth = `${Math.max(200, Math.min(rect.width, view.innerWidth - 2 * margin))}px`;
    menu.style.maxHeight = "";
    const height = menu.offsetHeight;
    const below = view.innerHeight - rect.bottom - margin - 4;
    const above = rect.top - margin - 4;
    const placeBelow = height <= below || below >= above;
    const room = Math.max(120, placeBelow ? below : above);
    menu.style.maxHeight = `${room}px`;
    const used = Math.min(height, room);
    menu.style.top = `${placeBelow ? rect.bottom + 4 : rect.top - 4 - used}px`;
    const width = menu.offsetWidth;
    const left = Math.min(Math.max(margin, rect.right - width), view.innerWidth - width - margin);
    menu.style.left = `${Math.max(margin, left)}px`;
  };

  const onWindowKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    // The dialog's own Escape handler runs in capture on document; win the race on window.
    event.preventDefault();
    event.stopImmediatePropagation();
    close();
    trigger.focus();
  };
  const onOutside = (event: Event) => {
    if (!event.composedPath().includes(root)) close();
  };
  const onDismiss = () => close();

  function open() {
    if (isOpen || disabled) return;
    options.onOpen?.();
    if (!items.length) return;
    isOpen = true;
    trigger.setAttribute("aria-expanded", "true");
    if (supportsPopover) menu.showPopover();
    else menu.setAttribute("data-open", "");
    position();
    focusOption(optionElements.get(value) ?? enabledOptions()[0]);
    view.addEventListener("keydown", onWindowKey, true);
    document.addEventListener("pointerdown", onOutside, true);
    view.addEventListener("resize", onDismiss);
    view.addEventListener("blur", onDismiss);
    document.addEventListener("scroll", onDismiss, true);
  }
  function close() {
    if (!isOpen) return;
    isOpen = false;
    trigger.setAttribute("aria-expanded", "false");
    if (supportsPopover && menu.matches(":popover-open")) menu.hidePopover();
    menu.removeAttribute("data-open");
    view.removeEventListener("keydown", onWindowKey, true);
    document.removeEventListener("pointerdown", onOutside, true);
    view.removeEventListener("resize", onDismiss);
    view.removeEventListener("blur", onDismiss);
    document.removeEventListener("scroll", onDismiss, true);
  }
  const choose = (el: HTMLElement) => {
    if (el.getAttribute("aria-disabled") === "true") return;
    const next = el.dataset.value ?? "";
    close();
    trigger.focus();
    if (next === value) return;
    picker.value = next;
    options.onChange(next);
  };

  trigger.addEventListener("click", () => (isOpen ? close() : open()));
  trigger.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    open();
  });
  menu.addEventListener("click", (event) => {
    const el = (event.target as Element).closest<HTMLElement>('[role="option"]');
    if (el) choose(el);
  });
  menu.addEventListener("keydown", (event) => {
    const list = enabledOptions();
    const active = (menu.getRootNode() as ShadowRoot).activeElement as HTMLElement | null;
    const at = active ? list.indexOf(active) : -1;
    if (event.key === "ArrowDown") focusOption(list[Math.min(list.length - 1, at + 1)]);
    else if (event.key === "ArrowUp") focusOption(list[Math.max(0, at - 1)]);
    else if (event.key === "Home") focusOption(list[0]);
    else if (event.key === "End") focusOption(list.at(-1));
    else if (event.key === "Enter" || event.key === " ") {
      if (active?.getAttribute("role") === "option") choose(active);
    } else if (event.key === "Tab") {
      close();
      trigger.focus();
      return;
    } else return;
    event.preventDefault();
  });

  const picker: SchedulePicker = {
    root,
    trigger,
    get value() {
      return value;
    },
    set value(next) {
      if (next === value) return;
      stale = null;
      value = next;
      for (const [key, el] of optionElements)
        el.setAttribute("aria-selected", String(key === next));
      renderTrigger();
    },
    get disabled() {
      return disabled;
    },
    set disabled(next) {
      if (next === disabled) return;
      disabled = next;
      renderTrigger();
    },
    get busy() {
      return busy;
    },
    set busy(next) {
      if (next === busy) return;
      busy = next;
      renderTrigger();
    },
    setItems(next) {
      const previous = selectedItem();
      stale =
        options.retainMissing && previous && !next.some((item) => item.value === value)
          ? { ...previous, disabled: true }
          : null;
      items = next;
      renderItems();
      renderTrigger();
    },
    setDisabledValues(next) {
      isDisabled = next;
      for (const item of items) {
        const el = optionElements.get(item.value);
        if (!el) continue;
        if (item.disabled || next(item.value)) el.setAttribute("aria-disabled", "true");
        else el.removeAttribute("aria-disabled");
      }
    },
    setPlaceholder(text, shimmerText = false) {
      if (text === placeholder && shimmerText === shimmer) return;
      placeholder = text;
      shimmer = shimmerText;
      renderTrigger();
    },
    close,
  };
  renderTrigger();
  return picker;
}
