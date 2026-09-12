import type { AccountCreditsSnapshot } from "@codexhost/shared-contracts";

import type { RendererSettingsLocale } from "./settings/localization.js";

import {
  applyRendererPopoverChrome,
  createRendererUsageRing,
  formatRendererCreditsPercent,
} from "./renderer-usage-control.js";
import {
  ensureRendererTriggerChipStyle,
  TRIGGER_CHIP_CLASS,
} from "./renderer-trigger-chip-style.js";

export interface RendererCreditsControl {
  root: HTMLDivElement;
  trigger: HTMLButtonElement;
  popover: HTMLDivElement;
  anchor: HTMLElement | null;
  dispose(): void;
  place(anchor: HTMLElement | null): boolean;
}

export type RendererCreditsTone = "ok" | "warn" | "hot";

export function rendererCreditsTone(usedPercent: number): RendererCreditsTone {
  if (usedPercent >= 90) return "hot";
  if (usedPercent >= 70) return "warn";
  return "ok";
}

interface RendererCreditsMessages {
  readonly remaining: string;
  readonly resets: string;
  readonly details: string;
  readonly weekly: string;
  readonly monthly: string;
  readonly fiveHour: string;
  readonly sevenDay: string;
  readonly account: string;
}

const ENGLISH_CREDITS_MESSAGES: RendererCreditsMessages = Object.freeze({
  remaining: "Remaining",
  resets: "Resets",
  details: "Account limit details",
  weekly: "Weekly limit",
  monthly: "Monthly limit",
  fiveHour: "5-hour limit",
  sevenDay: "7-day limit",
  account: "Account limit",
});

const CHINESE_CREDITS_MESSAGES: RendererCreditsMessages = Object.freeze({
  remaining: "剩余",
  resets: "重置",
  details: "账号额度详情",
  weekly: "周额度",
  monthly: "月额度",
  fiveHour: "5 小时额度",
  sevenDay: "7 天额度",
  account: "账号额度",
});

function rendererCreditsMessages(locale: RendererSettingsLocale): RendererCreditsMessages {
  return locale === "zh-CN" ? CHINESE_CREDITS_MESSAGES : ENGLISH_CREDITS_MESSAGES;
}

/**
 * Keep the source's minute precision, while making same-day resets easier to
 * scan and formatting both English and Chinese popovers in one presentation layer.
 */
export function formatRendererCreditsReset(
  value: string,
  now: Date = new Date(),
  locale: RendererSettingsLocale = "en",
): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (isToday) {
    const time = date.toLocaleTimeString(locale === "zh-CN" ? "zh-CN" : undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
    return locale === "zh-CN" ? `今天 ${time}` : `${time} today`;
  }
  return date.toLocaleString(locale === "zh-CN" ? "zh-CN" : undefined, {
    month: locale === "zh-CN" ? "long" : "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function creditsPeriodLabel(
  periodType: AccountCreditsSnapshot["periodType"],
  locale: RendererSettingsLocale = "en",
): string {
  const messages = rendererCreditsMessages(locale);
  if (periodType === "weekly") return messages.weekly;
  if (periodType === "monthly") return messages.monthly;
  if (periodType === "five_hour") return messages.fiveHour;
  if (periodType === "seven_day") return messages.sevenDay;
  return messages.account;
}

export function productLabel(product: string, locale: RendererSettingsLocale = "en"): string {
  if (product === "GrokBuild") return "Build";
  if (product === "GrokChat") return "Chat";
  if (product === "GrokImagine") return "Imagine";
  if (product === "GrokVoice") return "Voice";
  const messages = rendererCreditsMessages(locale);
  if (product === "5-hour window") return messages.fiveHour;
  if (product === "7-day window") return messages.sevenDay;
  if (product === "Weekly window") return messages.weekly;
  if (product.endsWith(" · 5-hour window")) {
    return `${product.slice(0, -"5-hour window".length)}${messages.fiveHour}`;
  }
  if (product.endsWith(" · 7-day window")) {
    return `${product.slice(0, -"7-day window".length)}${messages.sevenDay}`;
  }
  if (product.endsWith(" · Weekly window")) {
    return `${product.slice(0, -"Weekly window".length)}${messages.weekly}`;
  }
  if (product.endsWith(" · 5-hour")) {
    return `${product.slice(0, -"5-hour".length)}${messages.fiveHour}`;
  }
  if (product.endsWith(" · 7-day")) {
    return `${product.slice(0, -"7-day".length)}${messages.sevenDay}`;
  }
  return product;
}

function toneColor(tone: RendererCreditsTone): string {
  if (tone === "hot") return "#c45c4a";
  if (tone === "warn") return "#c9a227";
  return "#3d9a64";
}

function remainingPercent(usedPercent: number): number {
  return Math.min(100, Math.max(0, 100 - usedPercent));
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

function resetLabel(
  resetsAt: string,
  locale: RendererSettingsLocale,
  messages: RendererCreditsMessages,
): string {
  const formatted = formatRendererCreditsReset(resetsAt, new Date(), locale);
  return locale === "zh-CN" ? `${formatted} ${messages.resets}` : `${messages.resets} ${formatted}`;
}

function renderCreditsHeader(
  credits: AccountCreditsSnapshot,
  locale: RendererSettingsLocale,
  messages: RendererCreditsMessages,
): HTMLDivElement {
  const wrapper = document.createElement("div");
  wrapper.style.marginBottom = "11px";

  const top = document.createElement("div");
  top.style.display = "flex";
  top.style.alignItems = "flex-start";
  top.style.justifyContent = "space-between";
  top.style.gap = "12px";
  top.style.marginBottom = "5px";

  // Same left-label / right-percent column order as each tile below, so the
  // reset line always lands under its own label instead of zig-zagging sides.
  const left = document.createElement("div");
  const label = document.createElement("div");
  label.textContent = credits.label
    ? productLabel(credits.label, locale)
    : creditsPeriodLabel(credits.periodType, locale);
  label.style.fontSize = "12.5px";
  label.style.fontWeight = "600";
  left.append(label);
  if (credits.resetsAt) {
    const reset = document.createElement("div");
    reset.textContent = resetLabel(credits.resetsAt, locale, messages);
    reset.style.fontSize = "11px";
    reset.style.color = "color-mix(in srgb, currentColor 62%, transparent)";
    left.append(reset);
  }

  const color = toneColor(rendererCreditsTone(credits.usedPercent));
  const remaining = remainingPercent(credits.usedPercent);
  const percent = document.createElement("span");
  percent.style.display = "inline-flex";
  percent.style.alignItems = "baseline";
  percent.style.gap = "4px";
  percent.style.whiteSpace = "nowrap";
  percent.style.color = color;
  const remainingLabel = document.createElement("span");
  remainingLabel.textContent = `${messages.remaining} `;
  remainingLabel.style.fontSize = "11px";
  remainingLabel.style.fontWeight = "600";
  remainingLabel.style.opacity = "0.8";
  const remainingValue = document.createElement("span");
  remainingValue.textContent = formatRendererCreditsPercent(remaining);
  remainingValue.style.fontSize = "26px";
  remainingValue.style.fontWeight = "700";
  remainingValue.style.fontVariantNumeric = "tabular-nums";
  percent.append(remainingLabel, remainingValue);

  top.append(left, percent);

  wrapper.append(top, renderCreditsBar(remaining, color));
  return wrapper;
}

function renderCreditsTile(
  label: string,
  usagePercent: number,
  locale: RendererSettingsLocale,
  messages: RendererCreditsMessages,
  resetsAt?: string,
): HTMLDivElement {
  const color = toneColor(rendererCreditsTone(usagePercent));
  const remaining = remainingPercent(usagePercent);

  const tile = document.createElement("div");
  tile.style.marginBottom = "11px";

  const top = document.createElement("div");
  top.style.display = "flex";
  top.style.alignItems = "flex-start";
  top.style.justifyContent = "space-between";
  top.style.gap = "12px";
  top.style.marginBottom = "5px";

  const left = document.createElement("div");
  const name = document.createElement("span");
  name.textContent = label;
  name.style.fontSize = "12px";
  left.append(name);
  if (resetsAt) {
    const reset = document.createElement("div");
    reset.textContent = resetLabel(resetsAt, locale, messages);
    reset.style.fontSize = "10.5px";
    reset.style.color = "color-mix(in srgb, currentColor 62%, transparent)";
    left.append(reset);
  }

  const percent = document.createElement("span");
  percent.textContent = `${messages.remaining} ${formatRendererCreditsPercent(remaining)}`;
  percent.style.fontSize = "12px";
  percent.style.fontVariantNumeric = "tabular-nums";
  percent.style.color = color;
  top.append(left, percent);

  tile.append(top, renderCreditsBar(remaining, color));
  return tile;
}

function renderDetails(
  popover: HTMLDivElement,
  credits: AccountCreditsSnapshot,
  locale: RendererSettingsLocale,
): void {
  const messages = rendererCreditsMessages(locale);
  const glowColor = toneColor(rendererCreditsTone(credits.usedPercent));
  popover.style.backgroundImage = `radial-gradient(160px 100px at 18% -10%, color-mix(in srgb, ${glowColor} 20%, transparent), transparent 70%)`;
  popover.setAttribute("aria-label", messages.details);
  popover.replaceChildren();
  popover.append(renderCreditsHeader(credits, locale, messages));
  const tiles = (credits.productUsage ?? []).map((product) =>
    renderCreditsTile(
      productLabel(product.product, locale),
      product.usagePercent,
      locale,
      messages,
      product.resetsAt,
    ),
  );
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

function positionPopover(control: Pick<RendererCreditsControl, "trigger" | "popover">): void {
  const triggerRect = control.trigger.getBoundingClientRect();
  const width = Math.min(280, Math.max(220, window.innerWidth - 24));
  const left = Math.max(12, Math.min(triggerRect.left, window.innerWidth - width - 12));
  control.popover.style.width = `${width}px`;
  control.popover.style.left = `${left}px`;
  control.popover.style.right = "auto";
  control.popover.style.top = "auto";
  control.popover.style.bottom = `${Math.max(12, window.innerHeight - triggerRect.top + 8)}px`;
}

function closePopover(control: Pick<RendererCreditsControl, "trigger" | "popover">): void {
  if (popoverIsOpen(control.popover) && typeof control.popover.hidePopover === "function") {
    control.popover.hidePopover();
  }
  control.popover.hidden = true;
  control.trigger.setAttribute("aria-expanded", "false");
}

function openPopover(control: Pick<RendererCreditsControl, "trigger" | "popover">): void {
  positionPopover(control);
  control.popover.hidden = false;
  if (typeof control.popover.showPopover === "function" && !popoverIsOpen(control.popover)) {
    control.popover.showPopover();
  }
  control.trigger.setAttribute("aria-expanded", "true");
}

function togglePopover(control: Pick<RendererCreditsControl, "trigger" | "popover">): void {
  if (control.trigger.getAttribute("aria-expanded") === "true") closePopover(control);
  else openPopover(control);
}

export function mountRendererCreditsControl(composerId: string): RendererCreditsControl {
  ensureRendererTriggerChipStyle(document);

  const root = document.createElement("div");
  root.dataset.codexhostCreditsControl = composerId;
  root.className = "relative min-w-0";
  root.style.display = "none";
  root.style.alignItems = "center";
  root.style.alignSelf = "center";
  root.style.height = "28px";
  root.style.flex = "0 0 auto";
  root.style.verticalAlign = "middle";

  const trigger = document.createElement("button");
  trigger.className = TRIGGER_CHIP_CLASS;
  trigger.type = "button";
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-label", "Account limit");
  trigger.title = "Account limit";
  trigger.style.gap = "5px";
  trigger.style.width = "fit-content";
  trigger.style.maxWidth = "min(72px, 18vw)";
  // Match the 28px height shared by the Model/Permission-mode/Agent triggers
  // it sits next to — a shorter box here previously threw off the row's
  // vertical alignment (visible as Credits sitting a few px lower than its
  // neighbors), whether the host lays this row out as flex or inline content.
  trigger.style.height = "28px";
  trigger.style.padding = "0 8px";
  trigger.style.verticalAlign = "middle";
  trigger.style.fontSize = "12px";
  trigger.style.lineHeight = "16px";
  trigger.style.fontVariantNumeric = "tabular-nums";
  trigger.style.letterSpacing = "0";

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
  trigger.append(ringSlot, label);

  const popover = document.createElement("div");
  popover.id = `${composerId}-credits-popover`;
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", "Account limit details");
  popover.setAttribute("popover", "auto");
  popover.hidden = typeof popover.showPopover !== "function";
  popover.style.position = "fixed";
  popover.style.inset = "auto";
  popover.style.width = "240px";
  popover.style.maxWidth = "min(280px, calc(100vw - 24px))";
  popover.style.padding = "10px 12px";
  applyRendererPopoverChrome(popover);
  popover.style.font = "13px/1.35 system-ui, sans-serif";
  popover.style.letterSpacing = "0";
  popover.style.zIndex = "2147483647";
  trigger.setAttribute("aria-controls", popover.id);

  let placementReference: Element | null = null;
  const control: RendererCreditsControl = {
    root,
    trigger,
    popover,
    anchor: null,
    dispose() {
      closePopover(control);
      if (closeTimer !== null) window.clearTimeout(closeTimer);
      root.remove();
      popover.remove();
      placementReference = null;
    },
    place(anchor) {
      // Credits sits immediately *before* its anchor (the permission-mode
      // picker) rather than being derived by walking up from the Usage
      // control's current DOM position. Anchoring directly to a
      // renderer-owned, already-tracked element keeps this stable across
      // reconciliation passes instead of re-deriving a different ancestor
      // once the host page's own DOM settles a few seconds after mount.
      if (!anchor?.parentElement) return false;
      const parent = anchor.parentElement;
      if (
        control.anchor === anchor &&
        placementReference === anchor &&
        root.parentElement === parent &&
        root.nextElementSibling === anchor
      ) {
        return true;
      }
      control.anchor = anchor;
      placementReference = anchor;
      if (root !== anchor) parent.insertBefore(root, anchor);
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
      if (!trigger.matches(":hover") && !popover.matches(":hover")) closePopover(control);
    }, 140);
  };

  trigger.addEventListener("click", () => togglePopover(control));
  trigger.addEventListener("pointerenter", () => {
    cancelClose();
    openPopover(control);
  });
  trigger.addEventListener("pointerleave", scheduleClose);
  trigger.addEventListener("focus", () => {
    cancelClose();
    openPopover(control);
  });
  trigger.addEventListener("blur", scheduleClose);
  popover.addEventListener("pointerenter", cancelClose);
  popover.addEventListener("pointerleave", scheduleClose);
  popover.addEventListener("toggle", () => {
    trigger.setAttribute("aria-expanded", String(popoverIsOpen(popover)));
  });
  root.append(trigger);
  document.body.append(popover);
  return control;
}

export function renderRendererCreditsControl(
  control: RendererCreditsControl,
  accountCredits: AccountCreditsSnapshot | null,
  locale: RendererSettingsLocale = "en",
): boolean {
  if (accountCredits === null) {
    control.root.style.display = "none";
    closePopover(control);
    return false;
  }
  const remaining = remainingPercent(accountCredits.usedPercent);
  const percent = formatRendererCreditsPercent(remaining);
  const periodLabel = accountCredits.label
    ? productLabel(accountCredits.label, locale)
    : creditsPeriodLabel(accountCredits.periodType, locale);
  const title = `${periodLabel} ${percent}`;
  const tone = rendererCreditsTone(accountCredits.usedPercent);
  const ringSlot = control.trigger.querySelector<HTMLElement>("[data-codexhost-credits-ring]");
  const label = control.trigger.querySelector<HTMLElement>("[data-codexhost-credits-label]");
  if (ringSlot) {
    ringSlot.replaceChildren(
      createRendererUsageRing(remaining, {
        size: 14,
        strokeWidth: 2.4,
        color: toneColor(tone),
      }),
    );
  }
  if (label) label.textContent = percent;
  control.root.style.display = "inline-flex";
  control.trigger.setAttribute("aria-label", title);
  control.trigger.title = title;
  renderDetails(control.popover, accountCredits, locale);
  return true;
}
