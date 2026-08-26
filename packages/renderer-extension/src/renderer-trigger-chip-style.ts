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
 */
const STYLE_ATTRIBUTE = "data-codexhost-trigger-chip-style";
export const TRIGGER_CHIP_CLASS = "codexhost-trigger-chip";

export function ensureRendererTriggerChipStyle(ownerDocument: Document): void {
  if (ownerDocument.querySelector(`style[${STYLE_ATTRIBUTE}]`)) return;
  const style = ownerDocument.createElement("style");
  style.setAttribute(STYLE_ATTRIBUTE, "true");
  style.textContent = `
    .${TRIGGER_CHIP_CLASS} {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
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
