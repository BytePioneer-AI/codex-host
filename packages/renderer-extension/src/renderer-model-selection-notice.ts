import createElement from "lucide/dist/esm/createElement.mjs";
import CircleAlert from "lucide/dist/esm/icons/circle-alert.mjs";

import { rendererModelSelectionNoticePlacement } from "./renderer-model-picker-positioning.js";
import { applyRendererPopoverChrome } from "./renderer-usage-control.js";

/** Long enough to read one Host error sentence; hovering the notice pauses it. */
export const RENDERER_MODEL_SELECTION_NOTICE_DURATION_MS = 8000;

export interface RendererModelSelectionNotice {
  readonly element: HTMLElement;
  show(heading: string, message: string): void;
  hide(): void;
  isOpen(): boolean;
  reposition(): void;
  dispose(): void;
}

let nextNoticeId = 0;

/**
 * Host rejection of a Model or Thinking choice, portaled above the Composer's
 * clipped toolbar. The picker reverts to the confirmed choice, so without this
 * the rejection would only be visible as a hover title.
 */
export function mountRendererModelSelectionNotice(
  anchor: HTMLElement,
): RendererModelSelectionNotice {
  const document = anchor.ownerDocument;
  const view = document.defaultView ?? window;
  const notice = document.createElement("div");
  notice.id = `codexhost-model-selection-notice-${++nextNoticeId}`;
  notice.dataset.codexhostModelSelectionNotice = "true";
  notice.setAttribute("role", "alert");
  notice.setAttribute("aria-live", "assertive");
  notice.setAttribute("aria-atomic", "true");
  notice.setAttribute("popover", "manual");
  notice.hidden = true;
  // No inline `display`: it would override the closed popover's `display: none`.
  notice.style.cssText =
    "position:fixed;box-sizing:border-box;margin:0;inset:auto;padding:10px 12px;overflow:auto;font:13px/1.45 system-ui,sans-serif;letter-spacing:0;text-align:left;white-space:normal;overflow-wrap:anywhere;cursor:pointer;z-index:2147483647";
  applyRendererPopoverChrome(notice);
  // light-dark() accepts colors, not entire shadow lists.
  notice.style.boxShadow =
    "0 10px 24px light-dark(rgba(15, 23, 42, 0.12), rgba(0, 0, 0, 0.42)), 0 2px 8px light-dark(rgba(15, 23, 42, 0.06), rgba(0, 0, 0, 0.28))";

  const row = document.createElement("div");
  row.style.display = "flex";
  row.style.alignItems = "flex-start";
  row.style.gap = "8px";
  const mark = document.createElement("span");
  mark.style.display = "inline-flex";
  mark.style.flex = "none";
  mark.style.marginTop = "1px";
  mark.style.color = "var(--color-text-danger, #c2413b)";
  mark.append(
    createElement(CircleAlert, {
      width: 16,
      height: 16,
      "aria-hidden": "true",
      focusable: "false",
      "stroke-width": 1.8,
    }),
  );
  const copy = document.createElement("div");
  copy.style.minWidth = "0";
  const heading = document.createElement("div");
  heading.style.fontWeight = "600";
  const message = document.createElement("div");
  message.style.marginTop = "2px";
  message.style.color = "color-mix(in srgb, currentColor 68%, transparent)";
  copy.append(heading, message);
  row.append(mark, copy);
  notice.append(row);
  document.body.append(notice);

  let hideTimer: number | undefined;
  const cancelHide = (): void => {
    if (hideTimer !== undefined) view.clearTimeout(hideTimer);
    hideTimer = undefined;
  };
  const isOpen = (): boolean => notice.matches(":popover-open");
  const hide = (): void => {
    cancelHide();
    if (isOpen()) notice.hidePopover();
    notice.hidden = true;
  };
  const scheduleHide = (): void => {
    cancelHide();
    hideTimer = view.setTimeout(() => {
      hideTimer = undefined;
      hide();
    }, RENDERER_MODEL_SELECTION_NOTICE_DURATION_MS);
  };
  const anchorRendered = (): boolean => anchor.isConnected && anchor.getClientRects().length > 0;
  const reposition = (): void => {
    if (!isOpen()) return;
    if (!anchorRendered()) {
      hide();
      return;
    }
    const placement = rendererModelSelectionNoticePlacement(anchor.getBoundingClientRect(), {
      width: view.innerWidth,
      height: view.innerHeight,
    });
    notice.style.right = `${placement.right}px`;
    notice.style.bottom = `${placement.bottom}px`;
    notice.style.maxWidth = `${placement.maxWidth}px`;
    notice.style.maxHeight = `${placement.maxHeight}px`;
  };
  const show = (headingText: string, messageText: string): void => {
    if (!anchorRendered()) {
      hide();
      return;
    }
    heading.textContent = headingText;
    message.textContent = messageText;
    message.hidden = messageText.length === 0;
    notice.hidden = false;
    if (!isOpen()) notice.showPopover();
    reposition();
    scheduleHide();
  };
  const onPointerEnter = (): void => {
    if (isOpen()) cancelHide();
  };
  const onPointerLeave = (): void => {
    if (isOpen()) scheduleHide();
  };
  const onClick = (): void => {
    // Selecting the Host message to copy it must not dismiss the notice.
    const selection = view.getSelection();
    if (selection && !selection.isCollapsed && notice.contains(selection.anchorNode)) return;
    hide();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    // Dismiss only; the notice is not modal, so Escape keeps its Composer meaning.
    if (event.key === "Escape" && isOpen()) hide();
  };
  const listeners = new AbortController();
  const options = { signal: listeners.signal };
  notice.addEventListener("click", onClick, options);
  notice.addEventListener("pointerenter", onPointerEnter, options);
  notice.addEventListener("pointerleave", onPointerLeave, options);
  document.addEventListener("keydown", onKeyDown, { ...options, capture: true });
  view.addEventListener("resize", reposition, options);
  view.addEventListener("scroll", reposition, { ...options, capture: true });

  return {
    element: notice,
    show,
    hide,
    isOpen,
    reposition,
    dispose(): void {
      hide();
      listeners.abort();
      notice.remove();
    },
  };
}
