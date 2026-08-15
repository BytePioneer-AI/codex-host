import type { AccountCreditsSnapshot } from "@codexhost/shared-contracts";

import { RENDERER_MODEL_TRIGGER_FALLBACK_CLASSES } from "./renderer-model-picker.js";
import { formatRendererCreditsPercent } from "./renderer-usage-control.js";

export interface RendererCreditsControl {
  root: HTMLDivElement;
  trigger: HTMLButtonElement;
  popover: HTMLDivElement;
  anchor: HTMLElement | null;
  dispose(): void;
  place(anchor: HTMLElement | null): boolean;
  syncNativeModelClassName(className?: string): void;
}

export type RendererCreditsTone = "ok" | "warn" | "hot";

export function rendererCreditsTone(usedPercent: number): RendererCreditsTone {
  if (usedPercent >= 90) return "hot";
  if (usedPercent >= 70) return "warn";
  return "ok";
}

export function formatRendererCreditsReset(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function creditsPeriodLabel(periodType: AccountCreditsSnapshot["periodType"]): string {
  if (periodType === "weekly") return "Weekly limit";
  if (periodType === "monthly") return "Monthly limit";
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

function addDetailRow(parent: HTMLElement, label: string, value: string): void {
  const row = document.createElement("div");
  row.style.display = "grid";
  row.style.gridTemplateColumns = "minmax(0, 1fr) auto";
  row.style.gap = "20px";
  row.style.padding = "4px 0";
  const labelElement = document.createElement("span");
  labelElement.textContent = label;
  labelElement.style.color = "color-mix(in srgb, currentColor 68%, transparent)";
  const valueElement = document.createElement("span");
  valueElement.textContent = value;
  valueElement.style.fontVariantNumeric = "tabular-nums";
  valueElement.style.textAlign = "right";
  row.append(labelElement, valueElement);
  parent.append(row);
}

function renderDetails(popover: HTMLDivElement, credits: AccountCreditsSnapshot): void {
  popover.replaceChildren();
  const heading = document.createElement("div");
  heading.textContent = creditsPeriodLabel(credits.periodType);
  heading.style.fontWeight = "600";
  heading.style.marginBottom = "6px";
  popover.append(heading);
  addDetailRow(popover, "Used", formatRendererCreditsPercent(credits.usedPercent));
  if (credits.resetsAt) {
    addDetailRow(popover, "Resets", formatRendererCreditsReset(credits.resetsAt));
  }
  for (const product of credits.productUsage ?? []) {
    addDetailRow(
      popover,
      productLabel(product.product),
      formatRendererCreditsPercent(product.usagePercent),
    );
  }
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

export function mountRendererCreditsControl(
  composerId: string,
  nativeModelClassName?: string,
): RendererCreditsControl {
  const root = document.createElement("div");
  root.dataset.codexhostCreditsControl = composerId;
  root.className = "relative min-w-0";
  root.style.display = "none";

  const trigger = document.createElement("button");
  const syncNativeModelClassName = (className?: string): void => {
    trigger.className = className?.trim() || RENDERER_MODEL_TRIGGER_FALLBACK_CLASSES;
  };
  syncNativeModelClassName(nativeModelClassName);
  trigger.type = "button";
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-label", "Account limit");
  trigger.title = "Account limit";
  trigger.style.display = "inline-flex";
  trigger.style.alignItems = "center";
  trigger.style.gap = "5px";
  trigger.style.width = "fit-content";
  trigger.style.maxWidth = "min(72px, 18vw)";
  trigger.style.height = "24px";
  trigger.style.padding = "0 6px";
  trigger.style.borderRadius = "9999px";
  trigger.style.fontSize = "12px";
  trigger.style.lineHeight = "16px";
  trigger.style.fontVariantNumeric = "tabular-nums";
  trigger.style.letterSpacing = "0";
  trigger.style.whiteSpace = "nowrap";
  trigger.style.cursor = "pointer";

  const dot = document.createElement("span");
  dot.dataset.codexhostCreditsDot = "";
  dot.setAttribute("aria-hidden", "true");
  dot.style.display = "inline-block";
  dot.style.width = "7px";
  dot.style.height = "7px";
  dot.style.borderRadius = "9999px";
  dot.style.flex = "0 0 auto";

  const label = document.createElement("span");
  label.dataset.codexhostCreditsLabel = "";
  label.style.display = "inline-block";
  label.style.maxWidth = "100%";
  label.style.overflow = "hidden";
  label.style.textOverflow = "ellipsis";
  label.style.whiteSpace = "nowrap";
  trigger.append(dot, label);

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
  popover.style.border = "1px solid rgba(127, 127, 127, 0.35)";
  popover.style.borderRadius = "6px";
  popover.style.background = "Canvas";
  popover.style.color = "CanvasText";
  popover.style.boxShadow = "0 8px 24px rgba(0, 0, 0, 0.28)";
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
    syncNativeModelClassName,
    dispose() {
      closePopover(control);
      if (closeTimer !== null) window.clearTimeout(closeTimer);
      root.remove();
      popover.remove();
      placementReference = null;
    },
    place(anchor) {
      if (!anchor?.parentElement) return false;
      const parent = anchor.parentElement;
      const next = anchor.nextElementSibling;
      if (
        control.anchor === anchor &&
        placementReference === anchor &&
        root.parentElement === parent &&
        root.previousElementSibling === anchor
      ) {
        return true;
      }
      control.anchor = anchor;
      placementReference = anchor;
      if (next && next !== root) parent.insertBefore(root, next);
      else if (next !== root) parent.append(root);
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
): boolean {
  if (accountCredits === null) {
    control.root.style.display = "none";
    closePopover(control);
    return false;
  }
  const percent = formatRendererCreditsPercent(accountCredits.usedPercent);
  const title = `${creditsPeriodLabel(accountCredits.periodType)} ${percent}`;
  const tone = rendererCreditsTone(accountCredits.usedPercent);
  const dot = control.trigger.querySelector<HTMLElement>("[data-codexhost-credits-dot]");
  const label = control.trigger.querySelector<HTMLElement>("[data-codexhost-credits-label]");
  if (dot) dot.style.background = toneColor(tone);
  if (label) label.textContent = percent;
  control.root.style.display = "inline-flex";
  control.trigger.setAttribute("aria-label", title);
  control.trigger.title = title;
  renderDetails(control.popover, accountCredits);
  return true;
}
