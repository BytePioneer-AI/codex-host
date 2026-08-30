import type { ThreadUsageSnapshot } from "@codexhost/shared-contracts";

import {
  ensureRendererTriggerChipStyle,
  TRIGGER_CHIP_CLASS,
} from "./renderer-trigger-chip-style.js";

export interface RendererUsageControl {
  root: HTMLDivElement;
  trigger: HTMLButtonElement;
  popover: HTMLDivElement;
  anchor: HTMLElement | null;
  label: HTMLSpanElement;
  onOpen: (() => void) | null;
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

export function formatRendererNativeContextUsageDetails(usage: ThreadUsageSnapshot | null): string {
  if (!usage) return "";
  const details: string[] = [];
  if (usage.cacheHitRatePercent !== undefined) {
    details.push(`Latest cache hit: ${formatRendererCacheHitRate(usage.cacheHitRatePercent)}`);
  }
  if (usage.cachedInputTokens !== undefined) {
    details.push(`Cache read: ${formatRendererTokenCount(usage.cachedInputTokens)}`);
  }
  if (usage.cacheWriteInputTokens !== undefined) {
    details.push(`Cache write: ${formatRendererTokenCount(usage.cacheWriteInputTokens)}`);
  }
  if (usage.reasoningOutputTokens !== undefined) {
    details.push(`Reasoning: ${formatRendererTokenCount(usage.reasoningOutputTokens)}`);
  }
  if (usage.totalTokens !== undefined) {
    details.push(`Total tokens: ${formatRendererTokenCount(usage.totalTokens)}`);
  }
  if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
    details.push(
      `Input / output: ${formatRendererTokenCount(usage.inputTokens ?? 0)} / ${formatRendererTokenCount(usage.outputTokens ?? 0)}`,
    );
  }
  if (usage.outputTokensPerSecond !== undefined) {
    details.push(`Output speed: ${formatRendererTokenRate(usage.outputTokensPerSecond)}`);
  }
  if (usage.totalCostUsd !== undefined) {
    details.push(`Session cost: ${formatRendererCost(usage.totalCostUsd)}`);
  }
  return details.join("\n");
}

interface NativeContextUsageBinding {
  usage: ThreadUsageSnapshot | null;
  observer: MutationObserver | null;
  tooltip: HTMLElement | null;
  details: HTMLDivElement | null;
}

const nativeContextUsageBindings = new WeakMap<HTMLElement, NativeContextUsageBinding>();
const nativeContextTooltipTextPattern =
  /(context\s+window|tokens?|上下文窗口|背景信息窗口|令牌|标记|已用)/iu;

function nativeElementIsVisible(element: HTMLElement): boolean {
  if (element.hidden) return false;
  const view = element.ownerDocument?.defaultView;
  if (!view?.getComputedStyle) return true;
  try {
    const style = view.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  } catch {
    return true;
  }
}

function tooltipForNativeContext(element: HTMLElement): HTMLElement | null {
  const document = element.ownerDocument;
  if (!document) return null;
  const sources = [
    element,
    element.parentElement,
    typeof element.closest === "function"
      ? element.closest<HTMLElement>('button,[role="button"]')
      : null,
  ].filter(
    (source, index, all): source is HTMLElement => source !== null && all.indexOf(source) === index,
  );
  for (const source of sources) {
    const describedBy = source.getAttribute("aria-describedby") ?? "";
    for (const id of describedBy.split(/\s+/u).filter(Boolean)) {
      const candidate = document.getElementById(id);
      if (
        candidate !== null &&
        candidate.getAttribute("role") === "tooltip" &&
        nativeElementIsVisible(candidate as HTMLElement)
      ) {
        return candidate as HTMLElement;
      }
    }
  }
  const body = document.body;
  if (!body) return null;
  const candidates = [...body.querySelectorAll<HTMLElement>('[role="tooltip"]')].filter(
    (candidate) =>
      nativeElementIsVisible(candidate) &&
      nativeContextTooltipTextPattern.test(candidate.textContent ?? ""),
  );
  if (candidates.length <= 1) return candidates[0] ?? null;
  const triggerRect = element.getBoundingClientRect?.();
  if (!triggerRect || (triggerRect.width === 0 && triggerRect.height === 0))
    return candidates[0] ?? null;
  let nearest: HTMLElement | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const rect = candidate.getBoundingClientRect?.();
    if (!rect) continue;
    const dx = rect.left + rect.width / 2 - (triggerRect.left + triggerRect.width / 2);
    const dy = rect.top + rect.height / 2 - (triggerRect.top + triggerRect.height / 2);
    const distance = dx * dx + dy * dy;
    if (distance < nearestDistance) {
      nearest = candidate;
      nearestDistance = distance;
    }
  }
  return nearest ?? candidates[0] ?? null;
}

function nativeContextTooltipContent(tooltip: HTMLElement): HTMLElement {
  const content = [...tooltip.querySelectorAll<HTMLElement>("div")].find((candidate) => {
    const classes = ["flex", "w-38", "flex-col", "gap-0.5", "text-center"];
    return classes.every((className) => candidate.classList.contains(className));
  });
  return content ?? tooltip;
}

function syncNativeContextTooltip(binding: NativeContextUsageBinding, element: HTMLElement): void {
  const tooltip = tooltipForNativeContext(element);
  if (tooltip !== binding.tooltip || (binding.details && !binding.details.isConnected)) {
    binding.details?.remove();
    binding.details = null;
    binding.tooltip = tooltip;
  }
  const detailsText = formatRendererNativeContextUsageDetails(binding.usage);
  if (!tooltip || detailsText.length === 0) return;
  const parent = nativeContextTooltipContent(tooltip);
  let details = binding.details;
  if (!details || details.parentElement !== parent) {
    details?.remove();
    details = tooltip.ownerDocument.createElement("div");
    details.dataset.codexhostNativeUsageDetails = "";
    details.className = "mt-1 flex flex-col gap-0.5 text-center";
    details.style.font = "inherit";
    details.style.fontSize = "11px";
    details.style.lineHeight = "15px";
    details.style.color = "inherit";
    details.style.whiteSpace = "nowrap";
    details.style.overflow = "hidden";
    parent.append(details);
    binding.details = details;
  }
  if (details.dataset.codexhostNativeUsageDetailsText === detailsText) return;
  details.replaceChildren(
    ...detailsText.split("\n").map((line) => {
      const row = tooltip.ownerDocument.createElement("div");
      row.textContent = line;
      row.style.whiteSpace = "nowrap";
      return row;
    }),
  );
  details.dataset.codexhostNativeUsageDetailsText = detailsText;
}

/** Adds detailed Usage rows to Desktop's visible native Context tooltip. */
export function syncRendererNativeContextUsage(
  element: HTMLElement | null,
  usage: ThreadUsageSnapshot | null,
): void {
  if (!element) return;
  let binding = nativeContextUsageBindings.get(element);
  if (!binding) {
    binding = { usage, observer: null, tooltip: null, details: null };
    nativeContextUsageBindings.set(element, binding);
    const document = element.ownerDocument;
    const MutationObserverCtor =
      document?.defaultView?.MutationObserver ??
      (typeof MutationObserver === "function" ? MutationObserver : null);
    if (document?.body && MutationObserverCtor) {
      const bound = binding;
      binding.observer = new MutationObserverCtor(() => syncNativeContextTooltip(bound, element));
      binding.observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["aria-describedby", "class", "data-state", "hidden", "role", "style"],
      });
      binding.observer.observe(element, {
        attributes: true,
        attributeFilter: ["aria-describedby", "data-state", "hidden"],
      });
    }
  }
  binding.usage = usage;
  syncNativeContextTooltip(binding, element);
}

export function clearRendererNativeContextUsage(element: HTMLElement | null): void {
  if (!element) return;
  const binding = nativeContextUsageBindings.get(element);
  if (!binding) return;
  binding.observer?.disconnect();
  binding.details?.remove();
  nativeContextUsageBindings.delete(element);
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

export interface RendererUsageRingOptions {
  size: number;
  strokeWidth: number;
  color: string;
  trackColor?: string;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** A small radial progress ring (0-100), used by the credits/plan-usage pills and popovers. */
export function createRendererUsageRing(
  percent: number,
  options: RendererUsageRingOptions,
): SVGSVGElement {
  const { size, strokeWidth, color } = options;
  const trackColor = options.trackColor ?? "color-mix(in srgb, currentColor 18%, transparent)";
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.min(100, Math.max(0, percent));
  const offset = circumference * (1 - clamped / 100);
  const center = size / 2;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("aria-hidden", "true");
  svg.style.display = "block";
  svg.style.flex = "0 0 auto";
  svg.style.transform = "rotate(-90deg)";

  const track = document.createElementNS(SVG_NS, "circle");
  track.setAttribute("cx", String(center));
  track.setAttribute("cy", String(center));
  track.setAttribute("r", String(radius));
  track.setAttribute("fill", "none");
  track.setAttribute("stroke", trackColor);
  track.setAttribute("stroke-width", String(strokeWidth));

  const fill = document.createElementNS(SVG_NS, "circle");
  fill.setAttribute("cx", String(center));
  fill.setAttribute("cy", String(center));
  fill.setAttribute("r", String(radius));
  fill.setAttribute("fill", "none");
  fill.setAttribute("stroke", color);
  fill.setAttribute("stroke-width", String(strokeWidth));
  fill.setAttribute("stroke-linecap", "round");
  fill.setAttribute("stroke-dasharray", String(circumference));
  fill.setAttribute("stroke-dashoffset", String(offset));

  svg.append(track, fill);
  return svg;
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

/** Whether a snapshot contains anything useful for the left Usage popover. */
export function rendererUsageHasDisplayData(usage: ThreadUsageSnapshot | null): boolean {
  return (
    usage?.cacheHitRatePercent !== undefined ||
    usage?.outputTokensPerSecond !== undefined ||
    usage?.totalCostUsd !== undefined ||
    (usage?.contextUsedTokens !== undefined && usage.contextWindowTokens !== undefined) ||
    usage?.totalTokens !== undefined ||
    usage?.inputTokens !== undefined ||
    usage?.cachedInputTokens !== undefined ||
    usage?.cacheWriteInputTokens !== undefined ||
    usage?.outputTokens !== undefined ||
    usage?.reasoningOutputTokens !== undefined ||
    usage?.planFiveHourUsedPercent !== undefined ||
    usage?.planSevenDayUsedPercent !== undefined
  );
}

/**
 * Shared chrome for the Usage/Credits popovers: a raised card rather than a
 * flat system-color panel. `Canvas`/`CanvasText` still anchor the palette (so
 * this reads correctly regardless of the host page's own light/dark theme).
 *
 * Light and dark need different elevation recipes, not just inverted colors:
 * a light surface reads as clean when it stays near-white and lets a soft,
 * tight shadow carry the elevation; the same "tint the fill toward the
 * foreground colour" trick that lifts a dark surface off a near-black page
 * instead muddies a light one into flat grey, and the deep 45px/0.35-alpha
 * shadow tuned for a dark host smears into a dirty halo on a light one.
 * `light-dark()` switches on the same resolved `color-scheme` that already
 * drives `Canvas`/`CanvasText` here, so it tracks the host page's actual
 * theme rather than the OS preference.
 */
export function applyRendererPopoverChrome(popover: HTMLElement): void {
  popover.style.border =
    "1px solid light-dark(rgba(15, 23, 42, 0.10), color-mix(in srgb, CanvasText 16%, transparent))";
  popover.style.borderRadius = "14px";
  popover.style.backgroundColor = "light-dark(Canvas, color-mix(in srgb, Canvas 88%, white 12%))";
  popover.style.color = "CanvasText";
  popover.style.boxShadow =
    "light-dark(0 10px 24px rgba(15, 23, 42, 0.12), 0 20px 45px rgba(0, 0, 0, 0.42)), 0 2px 8px light-dark(rgba(15, 23, 42, 0.06), rgba(0, 0, 0, 0.28))";
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
  if (usage?.totalTokens !== undefined) {
    addDetailRow(popover, "Total tokens", formatRendererTokenCount(usage.totalTokens));
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

function openPopover(control: Pick<RendererUsageControl, "trigger" | "popover" | "onOpen">): void {
  const wasOpen = control.trigger.getAttribute("aria-expanded") === "true";
  positionPopover(control);
  control.popover.hidden = false;
  if (typeof control.popover.showPopover === "function" && !popoverIsOpen(control.popover)) {
    control.popover.showPopover();
  }
  control.trigger.setAttribute("aria-expanded", "true");
  if (!wasOpen) control.onOpen?.();
}

function togglePopover(
  control: Pick<RendererUsageControl, "trigger" | "popover" | "onOpen">,
): void {
  if (control.trigger.getAttribute("aria-expanded") === "true") closePopover(control);
  else openPopover(control);
}

export function mountRendererUsageControl(composerId: string): RendererUsageControl {
  ensureRendererTriggerChipStyle(document);

  const root = document.createElement("div");
  root.dataset.codexhostUsageControl = composerId;
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
  trigger.setAttribute("aria-label", "Thread Usage");
  trigger.title = "Thread Usage";
  // Usage is secondary metadata, not a primary composer action. Keep the
  // compact, muted treatment used by the previous Composer integration while
  // avoiding Codex's private trigger class names.
  trigger.style.color = "var(--color-text-tertiary, #8f8f8f)";
  trigger.style.gap = "4px";
  trigger.style.width = "fit-content";
  trigger.style.maxWidth = rendererUsageTriggerMaxWidth();
  // Match the 28px height shared by the Model/Permission-mode/Agent triggers
  // it sits next to — a shorter box here previously threw off the row's
  // vertical alignment (visible as Usage sitting a few px lower than its
  // neighbors), whether the host lays this row out as flex or inline content.
  trigger.style.height = "28px";
  trigger.style.padding = "0 8px";
  trigger.style.verticalAlign = "middle";
  trigger.style.fontSize = "12px";
  trigger.style.lineHeight = "16px";
  trigger.style.fontVariantNumeric = "tabular-nums";
  trigger.style.letterSpacing = "0";

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
  applyRendererPopoverChrome(popover);
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
    onOpen: null,
    dispose() {
      closePopover(control);
      if (closeTimer !== null) window.clearTimeout(closeTimer);
      root.remove();
      popover.remove();
      placementReference = null;
    },
    place(anchor) {
      if (!anchor?.parentElement) return false;
      const container = anchor.parentElement;
      if (
        control.anchor === anchor &&
        placementReference === anchor &&
        root.parentElement === container &&
        root.nextElementSibling === anchor
      ) {
        return true;
      }
      control.anchor = anchor;
      placementReference = anchor;
      container.insertBefore(root, anchor);
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
  const visible = rendererUsageHasDisplayData(usage);
  control.root.style.display = visible ? "inline-flex" : "none";
  if (!visible) {
    closePopover(control);
    return false;
  }

  const cacheHitRatePercent = usage?.cacheHitRatePercent;
  const outputTokensPerSecond = usage?.outputTokensPerSecond;
  const totalCostUsd = usage?.totalCostUsd;
  const hasContext =
    usage?.contextUsedTokens !== undefined && usage.contextWindowTokens !== undefined;
  const hasTokenUsage =
    usage?.totalTokens !== undefined ||
    usage?.inputTokens !== undefined ||
    usage?.cachedInputTokens !== undefined ||
    usage?.cacheWriteInputTokens !== undefined ||
    usage?.outputTokens !== undefined ||
    usage?.reasoningOutputTokens !== undefined;
  const hasPlanLimit =
    usage?.planFiveHourUsedPercent !== undefined || usage?.planSevenDayUsedPercent !== undefined;
  const summary = [
    cacheHitRatePercent !== undefined ? formatRendererCacheHitRate(cacheHitRatePercent) : null,
    outputTokensPerSecond !== undefined ? formatRendererTokenRate(outputTokensPerSecond) : null,
    totalCostUsd !== undefined ? formatRendererCost(totalCostUsd) : null,
  ].filter((value): value is string => value !== null);
  if (
    summary.length === 0 &&
    hasContext &&
    usage?.contextWindowTokens !== undefined &&
    usage.contextWindowTokens > 0
  ) {
    summary.push(
      `${decimal(((usage.contextUsedTokens ?? 0) / usage.contextWindowTokens) * 100, 1)}% context`,
    );
  }
  if (summary.length === 0 && usage?.totalTokens !== undefined) {
    summary.push(`${formatRendererTokenCount(usage.totalTokens)} tokens`);
  }
  if (summary.length === 0 && hasTokenUsage) {
    summary.push(
      `${formatRendererTokenCount((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0))} tokens`,
    );
  }
  if (summary.length === 0 && hasPlanLimit) {
    summary.push(
      usage?.planFiveHourUsedPercent !== undefined
        ? `5h ${formatRendererCreditsPercent(usage.planFiveHourUsedPercent)}`
        : `7d ${formatRendererCreditsPercent(usage?.planSevenDayUsedPercent ?? 0)}`,
    );
  }
  const compactSummary = summary.join(" · ");
  const accessibleSummary = `Thread Usage: ${compactSummary}`;
  control.trigger.style.maxWidth = rendererUsageTriggerMaxWidth();
  control.trigger.setAttribute("aria-label", accessibleSummary);
  control.trigger.title = accessibleSummary;
  control.label.textContent = compactSummary;
  renderDetails(control.popover, usage);
  return true;
}
