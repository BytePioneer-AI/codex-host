import { createRendererSettingsIcon } from "./icons.js";

let nextPreferenceId = 0;

export function preferenceId(prefix: string): string {
  nextPreferenceId += 1;
  return `codexhost-${prefix}-${nextPreferenceId}`;
}

export function createPreferenceGroup(
  document: Document,
  title: string,
): { group: HTMLElement; header: HTMLElement; card: HTMLElement } {
  const group = document.createElement("section");
  group.className = "mt-7 first-of-type:mt-0";
  const header = document.createElement("div");
  header.className = "mb-2 flex min-h-6 items-center gap-2 px-1";
  const heading = document.createElement("h3");
  heading.id = preferenceId("preference-group");
  heading.className = "m-0 text-[13px] leading-5 font-semibold text-settings-text";
  heading.textContent = title;
  header.append(heading);
  const card = document.createElement("div");
  card.className = "rounded-[10px] border border-settings-border bg-settings-panel";
  group.setAttribute("aria-labelledby", heading.id);
  group.append(header, card);
  return { group, header, card };
}

export function createPreferenceItem(
  document: Document,
  input: {
    title: string;
    description: string;
    controlId: string;
    help?: { label: string; lines: readonly string[] };
  },
): { item: HTMLElement; description: HTMLElement } {
  const item = document.createElement("div");
  // Rows own their divider so a hidden row never leaves a stray border behind.
  item.className =
    "flex min-h-[60px] items-center justify-between gap-6 border-t border-settings-divider px-4 py-3 first:border-t-0";
  const copy = document.createElement("div");
  copy.className = "flex min-w-0 flex-col gap-0.5";
  const heading = document.createElement("div");
  heading.className = "flex items-center gap-1.5";
  const title = document.createElement("label");
  title.htmlFor = input.controlId;
  title.className = "cursor-pointer text-[13px] leading-5 font-medium text-settings-text";
  title.textContent = input.title;
  heading.append(title);
  if (input.help) heading.append(createHelpTooltip(document, input.help.label, input.help.lines));
  const description = document.createElement("div");
  description.id = preferenceId("preference-description");
  description.className =
    "text-xs leading-[18px] text-settings-muted data-[invalid=true]:text-settings-danger";
  description.textContent = input.description;
  copy.append(heading, description);
  item.append(copy);
  return { item, description };
}

/** Hover or focus reveals the details, keeping long explanations out of the page body. */
export function createHelpTooltip(
  document: Document,
  label: string,
  lines: readonly string[],
): HTMLElement {
  const wrapper = document.createElement("span");
  wrapper.className = "group relative inline-flex";
  const button = document.createElement("button");
  button.type = "button";
  button.className =
    "inline-flex size-4 cursor-help items-center justify-center rounded-full border-0 bg-transparent p-0 text-settings-subtle transition-colors hover:text-settings-text focus-visible:text-settings-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-settings-focus";
  button.setAttribute("aria-label", label);
  button.append(createRendererSettingsIcon("help", 14));
  const tooltip = document.createElement("div");
  tooltip.id = preferenceId("preference-tooltip");
  tooltip.setAttribute("role", "tooltip");
  tooltip.className =
    "pointer-events-none invisible absolute top-full left-0 z-20 mt-2 w-80 rounded-lg border border-settings-border bg-settings-panel px-3 py-2.5 text-xs leading-[18px] font-normal text-settings-text opacity-0 shadow-[0_10px_30px_rgb(0_0_0/0.22)] transition-opacity duration-150 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100";
  const list = document.createElement("ul");
  list.className = "m-0 grid list-disc gap-1 pl-4 marker:text-settings-subtle";
  for (const line of lines) {
    const item = document.createElement("li");
    item.textContent = line;
    list.append(item);
  }
  tooltip.append(list);
  button.setAttribute("aria-describedby", tooltip.id);
  button.addEventListener("keydown", (event) => {
    if (event.key === "Escape") button.blur();
  });
  wrapper.append(button, tooltip);
  return wrapper;
}

export function createPreferenceSwitch(
  document: Document,
  id: string,
  describedBy: string,
): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "checkbox";
  input.id = id;
  input.setAttribute("role", "switch");
  input.setAttribute("aria-describedby", describedBy);
  input.className =
    "relative m-0 h-5 w-9 shrink-0 cursor-pointer appearance-none rounded-full bg-settings-surface-hover ring-1 ring-settings-border transition-colors ring-inset before:absolute before:top-0.5 before:left-0.5 before:size-4 before:rounded-full before:bg-white before:shadow-[0_1px_2px_rgb(0_0_0/0.3)] before:transition-transform checked:bg-settings-focus checked:ring-transparent checked:before:translate-x-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-settings-focus";
  return input;
}

export function createNumberField(
  document: Document,
  input: { id: string; describedBy: string; unit: string; min: number; max: number },
): { field: HTMLElement; control: HTMLInputElement } {
  const field = document.createElement("div");
  field.className =
    "flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-settings-border bg-settings-surface px-2.5 transition-colors focus-within:border-settings-focus data-[invalid=true]:border-settings-danger";
  const control = document.createElement("input");
  control.type = "number";
  control.id = input.id;
  control.min = String(input.min);
  control.max = String(input.max);
  control.step = "1";
  control.setAttribute("aria-describedby", input.describedBy);
  control.className =
    "w-14 border-0 bg-transparent p-0 text-right text-[13px] leading-5 text-settings-text tabular-nums outline-none";
  const unit = document.createElement("span");
  unit.className = "text-xs text-settings-muted";
  unit.setAttribute("aria-hidden", "true");
  unit.textContent = input.unit;
  field.append(control, unit);
  return { field, control };
}
