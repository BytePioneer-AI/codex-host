import type {
  AccountCreditsAccountUsage,
  AccountCreditsProductUsage,
  AccountCreditsSnapshot,
} from "@codexhost/shared-contracts";

import {
  applyRendererPopoverChrome,
  createRendererUsageRing,
  formatRendererCreditsPercent,
} from "./renderer-usage-control.js";
import {
  ensureRendererTriggerChipStyle,
  TRIGGER_CHIP_CLASS,
} from "./renderer-trigger-chip-style.js";

const CREDITS_STYLE_ATTRIBUTE = "data-codexhost-credits-style";
const HEADER_FAMILY_LABELS = new Set(["Gemini", "Grok", "Codex", "Claude"]);

export interface RendererCreditsHeaderEntry {
  label: string;
  usedPercent: number;
  resetsAt?: string;
  accounts?: AccountCreditsAccountUsage[];
  products: AccountCreditsProductUsage[];
}

export interface RendererCreditsControl {
  root: HTMLDivElement;
  trigger: HTMLButtonElement;
  extras: HTMLDivElement;
  extrasInner: HTMLDivElement;
  popover: HTMLDivElement;
  anchor: HTMLElement | null;
  expanded: boolean;
  entries: RendererCreditsHeaderEntry[];
  dispose(): void;
  /** Place the control immediately after `reference` in the app header. */
  place(reference: HTMLElement | null): boolean;
}

export type RendererCreditsTone = "ok" | "warn" | "hot";

export function rendererCreditsTone(usedPercent: number): RendererCreditsTone {
  if (usedPercent >= 90) return "hot";
  if (usedPercent >= 70) return "warn";
  return "ok";
}

/**
 * Compact provider label for the header chip. Prefer a short family name over
 * the full product window string so multiple providers can sit side-by-side.
 */
export function creditsProviderShortLabel(product: string): string {
  const normalized = product.trim();
  if (/^gemini/iu.test(normalized)) return "Gemini";
  if (/^grok/iu.test(normalized)) return "Grok";
  if (/^codex/iu.test(normalized)) return "Codex";
  if (/^claude/iu.test(normalized)) return "Claude";
  if (normalized === "GrokBuild") return "Grok";
  if (normalized === "GrokChat") return "Chat";
  if (normalized === "GrokImagine") return "Imagine";
  if (normalized === "GrokVoice") return "Voice";
  const token = normalized.split(/[\s(/]/u)[0]?.trim();
  return token && token.length > 0 ? token : "Limit";
}

/**
 * Map the Composer Model selection onto a quota family. OmniRoute labels look
 * like `grok-cli / grok-4` or `agy / gemini-3.7-flash-tiered`; native Grok and
 * Codex Agents contribute their agent id as a fallback hint.
 */
export function creditsFamilyFromSelection(selection: string | null | undefined): string | null {
  if (!selection || selection.trim().length === 0) return null;
  const text = selection.toLowerCase();
  if (/(?:^|[^a-z])grok(?:-cli)?(?:[^a-z]|$)/u.test(text) || text.includes("product_grok")) {
    return "Grok";
  }
  if (/(?:^|[^a-z])gemini(?:[^a-z]|$)/u.test(text)) return "Gemini";
  if (/(?:^|[^a-z])claude(?:[^a-z]|$)/u.test(text)) return "Claude";
  if (/(?:^|[^a-z])codex(?:[^a-z]|$)/u.test(text)) return "Codex";
  if (/(?:^|[^a-z])agy(?:[^a-z]|$)/u.test(text)) return "Gemini";
  return null;
}

export function creditsSelectionHint(input: {
  modelLabel?: string | undefined;
  modelId?: string | undefined;
  resolvedModelLabel?: string | undefined;
  agent?: string | undefined;
}): string {
  const parts = [input.modelLabel, input.modelId, input.resolvedModelLabel];
  if (input.agent === "grok" || input.agent === "codex") parts.push(input.agent);
  return parts
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join(" ");
}

function periodHeaderEntry(credits: AccountCreditsSnapshot): RendererCreditsHeaderEntry {
  const product = creditsPeriodLabel(credits.periodType);
  return {
    label: product.replace(/ limit$/iu, ""),
    usedPercent: credits.usedPercent,
    ...(credits.resetsAt ? { resetsAt: credits.resetsAt } : {}),
    products: [
      {
        product,
        usagePercent: credits.usedPercent,
        ...(credits.resetsAt ? { resetsAt: credits.resetsAt } : {}),
      },
    ],
  };
}

function entryRepresentsPrimary(
  entry: RendererCreditsHeaderEntry,
  credits: AccountCreditsSnapshot,
): boolean {
  if (entry.usedPercent === credits.usedPercent && entry.resetsAt === credits.resetsAt) {
    return true;
  }
  return entry.products.some(
    (product) =>
      product.usagePercent === credits.usedPercent && product.resetsAt === credits.resetsAt,
  );
}

function buildCreditsHeaderEntries(credits: AccountCreditsSnapshot): RendererCreditsHeaderEntry[] {
  if (!credits.productUsage || credits.productUsage.length === 0) {
    return [periodHeaderEntry(credits)];
  }

  const byLabel = new Map<string, RendererCreditsHeaderEntry>();
  for (const product of credits.productUsage) {
    const label = creditsProviderShortLabel(product.product);
    const previous = byLabel.get(label);
    const products = [...(previous?.products ?? []), product];
    const hotter = !previous || product.usagePercent > previous.usedPercent;
    byLabel.set(label, {
      label,
      usedPercent: hotter ? product.usagePercent : previous.usedPercent,
      ...(hotter
        ? product.resetsAt
          ? { resetsAt: product.resetsAt }
          : {}
        : previous.resetsAt
          ? { resetsAt: previous.resetsAt }
          : {}),
      ...(hotter
        ? product.accounts
          ? { accounts: product.accounts }
          : {}
        : previous.accounts
          ? { accounts: previous.accounts }
          : {}),
      products,
    });
  }
  const grouped = [...byLabel.values()];
  const known = grouped.filter((entry) => HEADER_FAMILY_LABELS.has(entry.label));
  const entries = known.length > 0 ? known : grouped;
  if (entries.some((entry) => entryRepresentsPrimary(entry, credits))) return entries;
  return [periodHeaderEntry(credits), ...entries];
}

export function creditsHeaderEntries(
  credits: AccountCreditsSnapshot,
  selection?: string | null,
): RendererCreditsHeaderEntry[] {
  const entries = buildCreditsHeaderEntries(credits);
  const family = creditsFamilyFromSelection(selection);
  if (!family) return entries;
  const index = entries.findIndex((entry) => entry.label === family);
  if (index <= 0) return entries;
  const selected = entries[index];
  if (!selected) return entries;
  return [selected, ...entries.filter((_, entryIndex) => entryIndex !== index)];
}

/**
 * A same-day reset reads as a precise time ("4:12 PM today") — the moment is
 * imminent and worth being exact about. Every other reset — tomorrow, or a
 * full week out — still carries its exact time alongside the date ("Aug 28,
 * 6:00 PM"): the source data is precise to the minute for both the 5-hour
 * and 7-day windows, so the display never throws that away.
 */
export function formatRendererCreditsReset(value: string, now: Date = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (isToday) {
    return `${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} today`;
  }
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function creditsPeriodLabel(periodType: AccountCreditsSnapshot["periodType"]): string {
  if (periodType === "weekly") return "Weekly limit";
  if (periodType === "monthly") return "Monthly limit";
  if (periodType === "five_hour") return "5-hour limit";
  if (periodType === "seven_day") return "7-day limit";
  return "Account limit";
}

function productLabel(product: string): string {
  if (product === "GrokBuild") return "Build";
  if (product === "GrokChat") return "Chat";
  if (product === "GrokImagine") return "Imagine";
  if (product === "GrokVoice") return "Voice";
  return product;
}

function toneColor(tone: RendererCreditsTone): string {
  if (tone === "hot") return "#c45c4a";
  if (tone === "warn") return "#c9a227";
  return "#3d9a64";
}

function ensureRendererCreditsStyle(ownerDocument: Document): void {
  if (ownerDocument.querySelector(`style[${CREDITS_STYLE_ATTRIBUTE}]`)) return;
  const style = ownerDocument.createElement("style");
  style.setAttribute(CREDITS_STYLE_ATTRIBUTE, "true");
  style.textContent = `
    [data-codexhost-credits-control] {
      cursor: pointer;
    }
    [data-codexhost-credits-chip] {
      cursor: pointer;
      -webkit-app-region: no-drag;
    }
    [data-codexhost-credits-chip]:hover:not(:disabled) {
      background: rgba(127, 127, 127, 0.18);
    }
    [data-codexhost-credits-expand] {
      display: inline-flex;
      flex: 0 0 auto;
      align-items: center;
      justify-content: center;
      width: 10px;
      font-size: 13px;
      line-height: 1;
      opacity: 0.38;
      transform: translateX(0);
      transition: opacity 140ms ease, transform 140ms ease;
    }
    [data-codexhost-credits-control]:hover [data-codexhost-credits-expand],
    [data-codexhost-credits-chip]:hover [data-codexhost-credits-expand],
    [data-codexhost-credits-chip]:focus-visible [data-codexhost-credits-expand] {
      opacity: 1;
      transform: translateX(2px);
    }
    [data-codexhost-credits-control][data-expanded="true"] [data-codexhost-credits-expand] {
      transform: rotate(180deg);
      opacity: 0.85;
    }
    [data-codexhost-credits-extras] {
      position: fixed;
      display: flex;
      align-items: center;
      max-width: 0;
      overflow: hidden;
      pointer-events: none;
      opacity: 0;
      transition: max-width 220ms ease, opacity 160ms ease;
    }
    [data-codexhost-credits-extras][data-expanded="true"] {
      max-width: min(480px, 70vw);
      opacity: 1;
      pointer-events: auto;
    }
    [data-codexhost-credits-extras-inner] {
      display: flex;
      min-width: 0;
      align-items: center;
      gap: 4px;
      padding-left: 4px;
    }
    @media (prefers-reduced-motion: reduce) {
      [data-codexhost-credits-extras],
      [data-codexhost-credits-expand] {
        transition: none;
      }
    }
  `;
  (ownerDocument.head ?? ownerDocument.documentElement).append(style);
}

function renderCreditsBar(usagePercent: number, color: string): HTMLDivElement {
  const track = document.createElement("div");
  track.dataset.codexhostCreditsBar = "";
  track.style.height = "6px";
  track.style.borderRadius = "9999px";
  track.style.background = "color-mix(in srgb, currentColor 16%, transparent)";
  track.style.overflow = "hidden";
  const fill = document.createElement("span");
  fill.style.display = "block";
  fill.style.height = "100%";
  fill.style.borderRadius = "9999px";
  fill.style.width = `${Math.min(100, Math.max(0, usagePercent))}%`;
  fill.style.background = color;
  track.append(fill);
  return track;
}

function mutedCaption(text: string, fontSize: string): HTMLDivElement {
  const caption = document.createElement("div");
  caption.textContent = text;
  caption.style.fontSize = fontSize;
  caption.style.color = "color-mix(in srgb, currentColor 62%, transparent)";
  return caption;
}

export interface RendererCreditsPopoverRow {
  label: string;
  usagePercent: number;
  resetsAt?: string;
  detail?: string;
}

/**
 * One popover row per account when OmniRoute reports them, otherwise one row
 * per product window. The family-level summary is omitted so the same percent
 * is never shown twice.
 */
export function creditsPopoverRows(entry: RendererCreditsHeaderEntry): RendererCreditsPopoverRow[] {
  const multipleWindows = entry.products.length > 1;
  const rows: RendererCreditsPopoverRow[] = [];
  for (const product of entry.products) {
    const windowLabel = productLabel(product.product);
    if (product.accounts && product.accounts.length > 0) {
      for (const account of product.accounts) {
        rows.push({
          label: account.accountName,
          usagePercent: account.usagePercent,
          ...(account.resetsAt
            ? { resetsAt: account.resetsAt }
            : product.resetsAt
              ? { resetsAt: product.resetsAt }
              : {}),
          ...(multipleWindows ? { detail: windowLabel } : {}),
        });
      }
      continue;
    }
    rows.push({
      label: windowLabel,
      usagePercent: product.usagePercent,
      ...(product.resetsAt ? { resetsAt: product.resetsAt } : {}),
    });
  }
  return rows;
}

function renderCreditsTile(row: RendererCreditsPopoverRow): HTMLDivElement {
  const color = toneColor(rendererCreditsTone(row.usagePercent));

  const tile = document.createElement("div");
  tile.style.marginBottom = "11px";

  const top = document.createElement("div");
  top.style.display = "flex";
  top.style.alignItems = "flex-start";
  top.style.justifyContent = "space-between";
  top.style.gap = "12px";
  top.style.marginBottom = "5px";

  const left = document.createElement("div");
  left.style.minWidth = "0";
  const name = document.createElement("div");
  name.textContent = row.label;
  name.style.fontSize = "12px";
  name.style.fontWeight = "600";
  name.style.overflow = "hidden";
  name.style.textOverflow = "ellipsis";
  name.style.whiteSpace = "nowrap";
  name.style.maxWidth = "190px";
  left.append(name);
  if (row.detail) left.append(mutedCaption(row.detail, "10.5px"));
  if (row.resetsAt) {
    left.append(mutedCaption(`resets ${formatRendererCreditsReset(row.resetsAt)}`, "10.5px"));
  }

  const percent = document.createElement("span");
  percent.textContent = formatRendererCreditsPercent(row.usagePercent);
  percent.style.fontSize = "16px";
  percent.style.fontWeight = "700";
  percent.style.fontVariantNumeric = "tabular-nums";
  percent.style.color = color;
  top.append(left, percent);

  tile.append(top, renderCreditsBar(row.usagePercent, color));
  return tile;
}

function renderDetails(popover: HTMLDivElement, entry: RendererCreditsHeaderEntry): void {
  const rows = creditsPopoverRows(entry);
  const glowColor = toneColor(rendererCreditsTone(rows[0]?.usagePercent ?? entry.usedPercent));
  popover.style.backgroundImage = `radial-gradient(160px 100px at 18% -10%, color-mix(in srgb, ${glowColor} 20%, transparent), transparent 70%)`;
  popover.replaceChildren();
  const tiles = rows.map((row) => renderCreditsTile(row));
  const lastTile = tiles.at(-1);
  if (lastTile) lastTile.style.marginBottom = "0";
  popover.append(...tiles);
}

function popoverIsOpen(popover: HTMLDivElement): boolean {
  try {
    return popover.matches(":popover-open");
  } catch {
    return !popover.hidden;
  }
}

function positionPopover(control: Pick<RendererCreditsControl, "root" | "popover">): void {
  const triggerRect = control.root.getBoundingClientRect();
  const width = Math.min(320, Math.max(240, window.innerWidth - 24));
  const left = Math.max(12, Math.min(triggerRect.left, window.innerWidth - width - 12));
  control.popover.style.width = `${width}px`;
  control.popover.style.left = `${left}px`;
  control.popover.style.right = "auto";

  const spaceAbove = triggerRect.top;
  const spaceBelow = window.innerHeight - triggerRect.bottom;
  if (spaceBelow >= spaceAbove) {
    control.popover.style.top = `${Math.min(window.innerHeight - 12, triggerRect.bottom + 8)}px`;
    control.popover.style.bottom = "auto";
    return;
  }
  control.popover.style.top = "auto";
  control.popover.style.bottom = `${Math.max(12, window.innerHeight - triggerRect.top + 8)}px`;
}

function positionCreditsExtras(control: RendererCreditsControl): void {
  const canExpand = control.expanded && control.entries.length > 1;
  control.extras.dataset.expanded = String(canExpand);
  control.extras.style.position = "fixed";
  control.extras.style.zIndex = "2147483646";
  if (!canExpand) return;
  control.extras.hidden = false;
  const rect = control.trigger.getBoundingClientRect();
  control.extras.style.left = `${Math.round(rect.right + 4)}px`;
  control.extras.style.top = `${Math.round(rect.top)}px`;
  control.extras.style.height = `${Math.round(rect.height)}px`;
}

function setCreditsExpanded(control: RendererCreditsControl, expanded: boolean): void {
  control.expanded = expanded;
  control.root.dataset.expanded = String(expanded);
  const value = String(expanded);
  control.trigger.setAttribute("aria-expanded", value);
  for (const button of [
    ...control.root.querySelectorAll<HTMLButtonElement>("[data-codexhost-credits-chip]"),
    ...control.extras.querySelectorAll<HTMLButtonElement>("[data-codexhost-credits-chip]"),
  ]) {
    button.setAttribute("aria-expanded", value);
  }
  positionCreditsExtras(control);
}

function closePopover(control: Pick<RendererCreditsControl, "root" | "trigger" | "popover">): void {
  if (popoverIsOpen(control.popover) && typeof control.popover.hidePopover === "function") {
    control.popover.hidePopover();
  }
  control.popover.hidden = true;
}

function openPopover(control: Pick<RendererCreditsControl, "root" | "trigger" | "popover">): void {
  positionPopover(control);
  control.popover.hidden = false;
  if (typeof control.popover.showPopover === "function" && !popoverIsOpen(control.popover)) {
    control.popover.showPopover();
  }
}

function entryForChip(
  control: RendererCreditsControl,
  chip: HTMLElement,
): RendererCreditsHeaderEntry | undefined {
  const family = chip.dataset.codexhostCreditsFamily;
  return control.entries.find((entry) => entry.label === family) ?? control.entries[0];
}

function showEntryPopover(control: RendererCreditsControl, chip: HTMLElement): void {
  const entry = entryForChip(control, chip);
  if (!entry) return;
  renderDetails(control.popover, entry);
  openPopover(control);
}

function styleCreditsChip(trigger: HTMLButtonElement): void {
  trigger.className = TRIGGER_CHIP_CLASS;
  trigger.type = "button";
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.setAttribute("aria-expanded", "false");
  trigger.dataset.codexhostCreditsChip = "";
  trigger.style.gap = "5px";
  trigger.style.width = "fit-content";
  trigger.style.maxWidth = "min(132px, 28vw)";
  trigger.style.height = "28px";
  trigger.style.padding = "0 8px";
  trigger.style.verticalAlign = "middle";
  trigger.style.fontSize = "12px";
  trigger.style.lineHeight = "16px";
  trigger.style.fontVariantNumeric = "tabular-nums";
  trigger.style.letterSpacing = "0";
  trigger.style.flex = "0 0 auto";
  trigger.style.cursor = "pointer";
  trigger.style.setProperty("-webkit-app-region", "no-drag");
}

function createCreditsChip(popoverId: string): HTMLButtonElement {
  const trigger = document.createElement("button");
  styleCreditsChip(trigger);
  trigger.setAttribute("aria-controls", popoverId);
  trigger.setAttribute("aria-label", "Account limit");
  trigger.title = "Account limit";

  const ringSlot = document.createElement("span");
  ringSlot.dataset.codexhostCreditsRing = "";
  ringSlot.style.display = "inline-flex";
  ringSlot.style.flex = "0 0 auto";

  const label = document.createElement("span");
  label.dataset.codexhostCreditsLabel = "";
  label.style.display = "inline-block";
  label.style.maxWidth = "100%";
  label.style.overflow = "hidden";
  label.style.textOverflow = "ellipsis";
  label.style.whiteSpace = "nowrap";
  const expand = document.createElement("span");
  expand.dataset.codexhostCreditsExpand = "";
  expand.setAttribute("aria-hidden", "true");
  expand.textContent = "›";
  expand.hidden = true;
  trigger.append(ringSlot, label, expand);
  return trigger;
}

function renderCreditsChipContent(
  trigger: HTMLButtonElement,
  entry: RendererCreditsHeaderEntry,
  expandable = false,
): void {
  const percent = formatRendererCreditsPercent(entry.usedPercent);
  const title = expandable
    ? `${entry.label} ${percent}. Click to show other quotas.`
    : `${entry.label} ${percent}`;
  const tone = rendererCreditsTone(entry.usedPercent);
  const ringSlot = trigger.querySelector<HTMLElement>("[data-codexhost-credits-ring]");
  const label = trigger.querySelector<HTMLElement>("[data-codexhost-credits-label]");
  const expand = trigger.querySelector<HTMLElement>("[data-codexhost-credits-expand]");
  if (ringSlot) {
    ringSlot.replaceChildren(
      createRendererUsageRing(entry.usedPercent, {
        size: 14,
        strokeWidth: 2.4,
        color: toneColor(tone),
      }),
    );
  }
  if (label) label.textContent = `${entry.label} ${percent}`;
  if (expand) expand.hidden = !expandable;
  trigger.dataset.codexhostCreditsFamily = entry.label;
  trigger.setAttribute("aria-label", title);
  trigger.title = title;
}

export function mountRendererCreditsControl(composerId: string): RendererCreditsControl {
  ensureRendererTriggerChipStyle(document);
  ensureRendererCreditsStyle(document);

  const root = document.createElement("div");
  root.dataset.codexhostCreditsControl = composerId;
  root.dataset.expanded = "false";
  root.className = "relative min-w-0";
  root.style.display = "none";
  root.style.alignItems = "center";
  root.style.alignSelf = "center";
  root.style.height = "28px";
  root.style.flex = "0 0 auto";
  root.style.gap = "0";
  root.style.marginLeft = "8px";
  root.style.verticalAlign = "middle";
  root.style.setProperty("-webkit-app-region", "no-drag");

  const extras = document.createElement("div");
  extras.dataset.codexhostCreditsExtras = "";
  extras.hidden = true;
  const extrasInner = document.createElement("div");
  extrasInner.dataset.codexhostCreditsExtrasInner = "";
  extras.append(extrasInner);

  const popover = document.createElement("div");
  popover.id = `${composerId}-credits-popover`;
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", "Account limit details");
  popover.setAttribute("popover", "auto");
  popover.hidden = typeof popover.showPopover !== "function";
  popover.style.position = "fixed";
  popover.style.inset = "auto";
  popover.style.width = "260px";
  popover.style.maxWidth = "min(320px, calc(100vw - 24px))";
  popover.style.maxHeight = "min(360px, calc(100vh - 24px))";
  popover.style.overflowY = "auto";
  popover.style.padding = "10px 12px";
  applyRendererPopoverChrome(popover);
  popover.style.font = "13px/1.35 system-ui, sans-serif";
  popover.style.letterSpacing = "0";
  popover.style.zIndex = "2147483647";

  const trigger = createCreditsChip(popover.id);
  let placementReference: Element | null = null;
  const repositionExtras = (): void => positionCreditsExtras(control);
  const control: RendererCreditsControl = {
    root,
    trigger,
    extras,
    extrasInner,
    popover,
    anchor: null,
    expanded: false,
    entries: [],
    dispose() {
      closePopover(control);
      if (closeTimer !== null) window.clearTimeout(closeTimer);
      document.removeEventListener("pointerdown", onDocumentPointerDown, true);
      window.removeEventListener("resize", repositionExtras);
      root.remove();
      extras.remove();
      popover.remove();
      placementReference = null;
    },
    place(reference) {
      // Insert immediately after the thread-title overflow (`…`) button.
      if (!reference?.parentElement) return false;
      const parent = reference.parentElement;
      const before = reference.nextSibling;
      if (
        control.anchor === reference &&
        placementReference === reference &&
        root.parentElement === parent &&
        root.previousSibling === reference
      ) {
        return true;
      }
      control.anchor = reference;
      placementReference = reference;
      parent.insertBefore(root, before);
      return true;
    },
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
      if (!root.matches(":hover") && !popover.matches(":hover") && !extras.matches(":hover")) {
        closePopover(control);
      }
    }, 140);
  };
  const onDocumentPointerDown = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (root.contains(target) || popover.contains(target) || extras.contains(target)) return;
    setCreditsExpanded(control, false);
    closePopover(control);
  };

  let lastToggleAt = 0;
  const toggleExpand = (event: Event): void => {
    const chip = (event.target as Element | null)?.closest?.("[data-codexhost-credits-chip]");
    if (!(chip instanceof HTMLButtonElement)) return;
    if (!root.contains(chip) && !extras.contains(chip)) return;
    if ("button" in event && typeof event.button === "number" && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const now = Date.now();
    if (now - lastToggleAt < 350) return;
    lastToggleAt = now;
    const canExpand = control.entries.length > 1;
    if (!canExpand) {
      if (popoverIsOpen(control.popover)) closePopover(control);
      else showEntryPopover(control, chip);
      return;
    }
    if (chip === control.trigger || !control.expanded) {
      setCreditsExpanded(control, !control.expanded);
    }
  };
  root.addEventListener("pointerdown", toggleExpand, true);
  root.addEventListener("click", toggleExpand, true);
  window.addEventListener("resize", repositionExtras);
  extras.addEventListener("pointerover", (event) => {
    const chip = (event.target as Element | null)?.closest?.("[data-codexhost-credits-chip]");
    if (!(chip instanceof HTMLButtonElement) || !extras.contains(chip)) return;
    cancelClose();
    showEntryPopover(control, chip);
  });
  extras.addEventListener("pointerleave", scheduleClose);
  extras.addEventListener("pointerdown", toggleExpand, true);
  root.addEventListener("pointerover", (event) => {
    const chip = (event.target as Element | null)?.closest?.("[data-codexhost-credits-chip]");
    if (!(chip instanceof HTMLButtonElement) || !root.contains(chip)) return;
    const related = event.relatedTarget;
    if (related instanceof Node && chip.contains(related)) return;
    cancelClose();
    showEntryPopover(control, chip);
  });
  root.addEventListener("pointerleave", scheduleClose);
  root.addEventListener(
    "focusin",
    (event) => {
      const chip = (event.target as Element | null)?.closest?.("[data-codexhost-credits-chip]");
      if (!(chip instanceof HTMLButtonElement) || !root.contains(chip)) return;
      cancelClose();
      showEntryPopover(control, chip);
    },
    true,
  );
  root.addEventListener("focusout", scheduleClose, true);
  popover.addEventListener("pointerenter", cancelClose);
  popover.addEventListener("pointerleave", scheduleClose);
  document.addEventListener("pointerdown", onDocumentPointerDown, true);
  root.append(trigger);
  document.body.append(extras, popover);
  return control;
}

export function renderRendererCreditsControl(
  control: RendererCreditsControl,
  accountCredits: AccountCreditsSnapshot | null,
  selection?: string | null,
): boolean {
  if (accountCredits === null) {
    control.root.style.display = "none";
    control.entries = [];
    setCreditsExpanded(control, false);
    closePopover(control);
    return false;
  }

  const previousFamily = control.entries[0]?.label;
  const entries = creditsHeaderEntries(accountCredits, selection);
  control.entries = entries;
  if (entries[0]?.label !== previousFamily) setCreditsExpanded(control, false);

  const popoverId = control.popover.id;
  const extraEntries = entries.slice(1);
  renderCreditsChipContent(
    control.trigger,
    entries[0] ?? { label: "Limit", usedPercent: 0, products: [] },
    extraEntries.length > 0,
  );
  let extraChips = [
    ...control.extrasInner.querySelectorAll<HTMLButtonElement>("[data-codexhost-credits-chip]"),
  ];
  while (extraChips.length < extraEntries.length) {
    const chip = createCreditsChip(popoverId);
    control.extrasInner.append(chip);
    extraChips = [
      ...control.extrasInner.querySelectorAll<HTMLButtonElement>("[data-codexhost-credits-chip]"),
    ];
  }
  while (extraChips.length > extraEntries.length) {
    extraChips.pop()?.remove();
    extraChips = [
      ...control.extrasInner.querySelectorAll<HTMLButtonElement>("[data-codexhost-credits-chip]"),
    ];
  }
  for (const [index, entry] of extraEntries.entries()) {
    const chip = extraChips[index];
    if (!chip) continue;
    renderCreditsChipContent(chip, entry);
  }

  control.extras.hidden = extraEntries.length === 0;
  control.root.style.display = "inline-flex";
  if (popoverIsOpen(control.popover)) {
    const hovered = control.root.querySelector<HTMLElement>(
      "[data-codexhost-credits-chip]:hover, [data-codexhost-credits-chip]:focus",
    );
    const entry = hovered ? entryForChip(control, hovered) : entries[0];
    if (entry) renderDetails(control.popover, entry);
  }
  return true;
}
