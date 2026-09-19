/**
 * Shared, host-independent "chip" chrome for the small trailing-cluster
 * trigger buttons we own (Model, Permission mode, Credits, Usage).
 *
 * These used to borrow Codex's own generated Composer button class names
 * (copied at runtime from a native button, or a hardcoded snapshot of them
 * as a fallback) so they would visually blend in. Codex's private class
 * names — and the design tokens they resolve to — are not a stable contract
 * and can be renamed or removed between Desktop releases, which silently
 * strips all chrome (background, padding, hover/disabled states) from these
 * controls. Defining our own tiny stylesheet instead keeps their look
 * stable across host updates: the base chip class supplies the pseudo-class
 * behavior (`:hover`, `:disabled`, `[data-state="open"]`) that inline styles
 * cannot express, while each control still sets its own inline
 * height/padding/font-size to size itself.
 *
 * Squeeze adaptation: external Harnesses inject more footer chips than native
 * Codex. When the sidebar opens or the window narrows, those chips must share
 * the remaining row (`flex-shrink`) and ellipsis instead of overlapping. The
 * root is a shrinkable flex item with a max width; the trigger fills that
 * root so label truncation can take effect.
 */
const STYLE_ATTRIBUTE = "data-codexhost-trigger-chip-style";
export const TRIGGER_CHIP_CLASS = "codexhost-trigger-chip";
export const TRIGGER_CHIP_ROOT_CLASS = "codexhost-trigger-chip-root";

/** Floor so a squeezed chip remains clickable. */
export const TRIGGER_CHIP_SQUEEZE_MIN_WIDTH = "48px";

export function rendererModelTriggerMaxWidth(): string {
  return "min(200px, 26vw)";
}

export function rendererPermissionModeTriggerMaxWidth(): string {
  return "min(160px, 24vw)";
}

export function rendererUsageTriggerMaxWidth(): string {
  return "min(140px, 22vw)";
}

export function rendererCreditsTriggerMaxWidth(): string {
  return "min(72px, 16vw)";
}

/**
 * Make a composer chip root participate in footer squeeze: shrink under flex
 * pressure, never grow past its label budget, and clip rather than paint over
 * neighbors when the row is still too tight.
 */
export function applyRendererTriggerChipSqueezeRoot(
  root: HTMLElement,
  maxWidth: string,
  minWidth: string = TRIGGER_CHIP_SQUEEZE_MIN_WIDTH,
): void {
  // Unit tests pass partial Composer control mocks; skip when style/classList
  // are absent rather than throwing during native-control reconciliation.
  if (!root?.style) return;
  root.classList?.add(TRIGGER_CHIP_ROOT_CLASS);
  root.style.flex = "0 1 auto";
  root.style.minWidth = minWidth;
  root.style.maxWidth = maxWidth;
  root.style.overflow = "hidden";
}

/**
 * Size the trigger to the squeezed root so `truncate` / ellipsis on the label
 * can activate. Call after (re)applying `TRIGGER_CHIP_CLASS`.
 */
export function applyRendererTriggerChipSqueezeTrigger(trigger: HTMLElement): void {
  if (!trigger?.style) return;
  trigger.style.boxSizing = "border-box";
  trigger.style.minWidth = "0";
  trigger.style.width = "100%";
  trigger.style.maxWidth = "100%";
  trigger.style.overflow = "hidden";
}

export function ensureRendererTriggerChipStyle(ownerDocument: Document): void {
  if (ownerDocument.querySelector(`style[${STYLE_ATTRIBUTE}]`)) return;
  const style = ownerDocument.createElement("style");
  style.setAttribute(STYLE_ATTRIBUTE, "true");
  style.textContent = `
    .${TRIGGER_CHIP_ROOT_CLASS} {
      min-width: 0;
      max-width: 100%;
      overflow: hidden;
    }
    .${TRIGGER_CHIP_CLASS} {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
      min-width: 0;
      max-width: 100%;
      overflow: hidden;
      border: 0;
      border-radius: 9999px;
      background: transparent;
      color: inherit;
      white-space: nowrap;
      cursor: pointer;
    }
    .${TRIGGER_CHIP_CLASS}:hover:not(:disabled) {
      background: rgba(127, 127, 127, 0.08);
    }
    .${TRIGGER_CHIP_CLASS}:active:not(:disabled) {
      background: rgba(127, 127, 127, 0.16);
    }
    .${TRIGGER_CHIP_CLASS}[data-state="open"] {
      background: rgba(127, 127, 127, 0.08);
    }
    .${TRIGGER_CHIP_CLASS}:disabled {
      cursor: not-allowed;
      opacity: 0.4;
    }
  `;
  (ownerDocument.head ?? ownerDocument.documentElement).append(style);
}
