import type { ThreadUsageSnapshot } from "@codexhost/shared-contracts";

import { RENDERER_MODEL_TRIGGER_FALLBACK_CLASSES } from "./renderer-model-picker.js";

export interface RendererUsageControl {
  root: HTMLDivElement;
  trigger: HTMLButtonElement;
  popover: HTMLDivElement;
  anchor: HTMLElement | null;
  label: HTMLSpanElement;
  syncNativeModelClassName(className?: string): void;
  dispose(): void;
  place(anchor: HTMLElement | null): boolean;
}

function decimal(value: number, fractionDigits: number): string {
  return value.toFixed(fractionDigits).replace(/\.?0+$/u, "");
}

export function formatRendererCacheHitRate(value: number): string {
  return `CH ${decimal(value, 1)}%`;
}

export function formatRendererCost(value: number): string {
  return `$${value.toFixed(3)}`;
}

export function formatRendererTokenRate(value: number): string {
  return `${decimal(value, 1)} tok/s`;
}

export function formatRendererTokenCount(value: number): string {
  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(value);
  if (absolute < 1000) return `${sign}${Math.round(absolute)}`;
  return `${sign}${decimal(absolute / 1000, 1)}k`;
}

export function formatRendererCreditsPercent(value: number): string {
  return `${decimal(value, 1)}%`;
}

export function formatRendererPlanReset(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatRendererPlanWindow(usedPercent: number, resetsAtUnix?: number): string {
  const percent = formatRendererCreditsPercent(usedPercent);
  if (resetsAtUnix === undefined) return percent;
  const reset = formatRendererPlanReset(resetsAtUnix);
  return reset.length > 0 ? `${percent} · ${reset}` : percent;
}

export function rendererUsageTriggerMaxWidth(): string {
  return "min(180px, 30vw)";
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

function renderDetails(popover: HTMLDivElement, usage: ThreadUsageSnapshot | null): void {
  popover.replaceChildren();
  const heading = document.createElement("div");
  heading.textContent = "Usage";
  heading.style.fontWeight = "600";
  heading.style.marginBottom = "6px";
  popover.append(heading);

  if (usage?.contextUsedTokens !== undefined && usage.contextWindowTokens !== undefined) {
    const contextPercent =
      usage.contextWindowTokens > 0
        ? (usage.contextUsedTokens / usage.contextWindowTokens) * 100
        : null;
    addDetailRow(
      popover,
      "Context",
      contextPercent === null
        ? `/${formatRendererTokenCount(usage.contextWindowTokens)}`
        : `${decimal(contextPercent, 1)}% / ${formatRendererTokenCount(usage.contextWindowTokens)}`,
    );
  }
  if (usage?.cacheHitRatePercent !== undefined) {
    addDetailRow(
      popover,
      "Latest cache hit",
      formatRendererCacheHitRate(usage.cacheHitRatePercent),
    );
  }
  if (usage?.outputTokensPerSecond !== undefined) {
    addDetailRow(popover, "Output speed", formatRendererTokenRate(usage.outputTokensPerSecond));
  }
  if (usage?.cachedInputTokens !== undefined) {
    addDetailRow(popover, "Cache read", formatRendererTokenCount(usage.cachedInputTokens));
  }
  if (usage?.cacheWriteInputTokens !== undefined) {
    addDetailRow(popover, "Cache write", formatRendererTokenCount(usage.cacheWriteInputTokens));
  }
  if (usage?.reasoningOutputTokens !== undefined) {
    addDetailRow(popover, "Reasoning", formatRendererTokenCount(usage.reasoningOutputTokens));
  }
  if (usage?.inputTokens !== undefined || usage?.outputTokens !== undefined) {
    addDetailRow(
      popover,
      "Input / output",
      `${formatRendererTokenCount(usage.inputTokens ?? 0)} / ${formatRendererTokenCount(usage.outputTokens ?? 0)}`,
    );
  }
  if (usage?.planFiveHourUsedPercent !== undefined) {
    addDetailRow(
      popover,
      "5-hour limit",
      formatRendererPlanWindow(usage.planFiveHourUsedPercent, usage.planFiveHourResetsAtUnix),
    );
  }
  if (usage?.planSevenDayUsedPercent !== undefined) {
    addDetailRow(
      popover,
      "7-day limit",
      formatRendererPlanWindow(usage.planSevenDayUsedPercent, usage.planSevenDayResetsAtUnix),
    );
  }
  if (usage?.totalCostUsd !== undefined) {
    addDetailRow(popover, "Session cost estimate", formatRendererCost(usage.totalCostUsd));
  }
}

function popoverIsOpen(popover: HTMLDivElement): boolean {
  try {
    return popover.matches(":popover-open");
  } catch {
    return !popover.hidden;
  }
}

function positionPopover(control: Pick<RendererUsageControl, "trigger" | "popover">): void {
  const triggerRect = control.trigger.getBoundingClientRect();
  const width = Math.min(320, Math.max(260, window.innerWidth - 24));
  const left = Math.max(12, Math.min(triggerRect.left, window.innerWidth - width - 12));
  control.popover.style.width = `${width}px`;
  control.popover.style.left = `${left}px`;
  control.popover.style.right = "auto";
  control.popover.style.top = "auto";
  control.popover.style.bottom = `${Math.max(12, window.innerHeight - triggerRect.top + 8)}px`;
}

function closePopover(control: Pick<RendererUsageControl, "trigger" | "popover">): void {
  if (popoverIsOpen(control.popover) && typeof control.popover.hidePopover === "function") {
    control.popover.hidePopover();
  }
  control.popover.hidden = true;
  control.trigger.setAttribute("aria-expanded", "false");
}

function openPopover(control: Pick<RendererUsageControl, "trigger" | "popover">): void {
  positionPopover(control);
  control.popover.hidden = false;
  if (typeof control.popover.showPopover === "function" && !popoverIsOpen(control.popover)) {
    control.popover.showPopover();
  }
  control.trigger.setAttribute("aria-expanded", "true");
}

function togglePopover(control: Pick<RendererUsageControl, "trigger" | "popover">): void {
  if (control.trigger.getAttribute("aria-expanded") === "true") closePopover(control);
  else openPopover(control);
}

export function mountRendererUsageControl(
  composerId: string,
  nativeModelClassName?: string,
): RendererUsageControl {
  const root = document.createElement("div");
  root.dataset.codexhostUsageControl = composerId;
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
  trigger.setAttribute("aria-label", "Thread Usage");
  trigger.title = "Thread Usage";
  trigger.style.display = "inline-flex";
  trigger.style.alignItems = "center";
  trigger.style.width = "fit-content";
  trigger.style.maxWidth = rendererUsageTriggerMaxWidth();
  trigger.style.height = "24px";
  trigger.style.padding = "0 4px";
  trigger.style.borderRadius = "9999px";
  trigger.style.fontSize = "12px";
  trigger.style.lineHeight = "16px";
  trigger.style.fontVariantNumeric = "tabular-nums";
  trigger.style.letterSpacing = "0";
  trigger.style.whiteSpace = "nowrap";
  trigger.style.cursor = "pointer";

  const label = document.createElement("span");
  label.style.display = "inline-block";
  label.style.maxWidth = "100%";
  label.style.overflow = "hidden";
  label.style.textOverflow = "ellipsis";
  label.style.whiteSpace = "nowrap";
  trigger.append(label);

  const popover = document.createElement("div");
  popover.id = `${composerId}-usage-popover`;
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", "Thread Usage details");
  popover.setAttribute("popover", "auto");
  popover.hidden = typeof popover.showPopover !== "function";
  popover.style.position = "fixed";
  popover.style.inset = "auto";
  popover.style.width = "260px";
  popover.style.maxWidth = "min(320px, calc(100vw - 24px))";
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
  const control: RendererUsageControl = {
    root,
    trigger,
    popover,
    anchor: null,
    label,
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
      let reference: Element = anchor;
      let container = anchor.parentElement;
      while (
        container.parentElement &&
        (getComputedStyle(container).display === "inline" ||
          (container.tagName === "SPAN" && container.attributes.length === 0))
      ) {
        reference = container;
        container = container.parentElement;
      }
      if (
        control.anchor === anchor &&
        placementReference === reference &&
        root.parentElement === container &&
        root.nextElementSibling === reference
      ) {
        return true;
      }
      control.anchor = anchor;
      placementReference = reference;
      container.insertBefore(root, reference);
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
    const open = popoverIsOpen(popover);
    trigger.setAttribute("aria-expanded", String(open));
  });
  root.append(trigger);
  document.body.append(popover);

  return control;
}

export function renderRendererUsageControl(
  control: RendererUsageControl,
  usage: ThreadUsageSnapshot | null,
): boolean {
  const cacheHitRatePercent = usage?.cacheHitRatePercent;
  const outputTokensPerSecond = usage?.outputTokensPerSecond;
  const totalCostUsd = usage?.totalCostUsd;
  const hasCacheHitRate = cacheHitRatePercent !== undefined;
  const hasOutputSpeed = outputTokensPerSecond !== undefined;
  const hasCost = totalCostUsd !== undefined;
  const visible = hasCacheHitRate || hasOutputSpeed || hasCost;
  control.root.style.display = visible ? "inline-flex" : "none";
  if (!visible) {
    closePopover(control);
    return false;
  }

  const summary = [
    cacheHitRatePercent !== undefined ? formatRendererCacheHitRate(cacheHitRatePercent) : null,
    outputTokensPerSecond !== undefined ? formatRendererTokenRate(outputTokensPerSecond) : null,
    totalCostUsd !== undefined ? formatRendererCost(totalCostUsd) : null,
  ].filter((value): value is string => value !== null);
  const compactSummary = summary.join(" · ");
  const accessibleSummary = `Thread Usage: ${compactSummary}`;
  control.trigger.style.maxWidth = rendererUsageTriggerMaxWidth();
  control.trigger.setAttribute("aria-label", accessibleSummary);
  control.trigger.title = accessibleSummary;
  control.label.textContent = compactSummary;
  renderDetails(control.popover, usage);
  return true;
}
