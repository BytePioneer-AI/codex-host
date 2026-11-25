import { applyRendererPopoverChrome } from "./renderer-usage-control.js";

let nextTooltipId = 0;

/** Host-owned Fast help, portaled above the composer's clipped toolbar. */
export function mountRendererModelFastTooltip(button: HTMLButtonElement) {
  const document = button.ownerDocument;
  const view = document.defaultView ?? window;
  const popover = document.createElement("div");
  popover.id = `codexhost-fast-tooltip-${++nextTooltipId}`;
  popover.setAttribute("role", "tooltip");
  popover.setAttribute("popover", "manual");
  popover.hidden = true;
  popover.style.cssText =
    "position:fixed;box-sizing:border-box;margin:0;inset:auto;padding:10px 12px;max-height:calc(100vh - 24px);overflow:auto;font:13px/1.5 system-ui,sans-serif;letter-spacing:0;overflow-wrap:anywhere;z-index:2147483647";
  applyRendererPopoverChrome(popover);
  // light-dark() accepts colors, not entire shadow lists.
  popover.style.boxShadow =
    "0 10px 24px light-dark(rgba(15, 23, 42, 0.12), rgba(0, 0, 0, 0.42)), 0 2px 8px light-dark(rgba(15, 23, 42, 0.06), rgba(0, 0, 0, 0.28))";
  const heading = document.createElement("div");
  heading.style.fontWeight = "600";
  heading.style.marginBottom = "6px";
  const description = document.createElement("div");
  description.style.color = "color-mix(in srgb, currentColor 68%, transparent)";
  popover.append(heading, description);
  document.body.append(popover);
  button.setAttribute("aria-describedby", popover.id);

  let closeTimer: number | undefined;
  const cancelClose = (): void => {
    if (closeTimer !== undefined) view.clearTimeout(closeTimer);
    closeTimer = undefined;
  };
  const close = (): void => {
    cancelClose();
    if (popover.matches(":popover-open")) popover.hidePopover();
    popover.hidden = true;
  };
  const position = (): void => {
    const anchor = button.getBoundingClientRect();
    const margin = 12;
    const width = Math.min(280, Math.max(0, view.innerWidth - margin * 2));
    popover.style.width = `${width}px`;
    popover.style.left = `${Math.max(margin, Math.min(anchor.left, view.innerWidth - width - margin))}px`;
    const height = popover.getBoundingClientRect().height;
    const above = anchor.top - height - 8;
    const top = above >= margin ? above : anchor.bottom + 8;
    popover.style.top = `${Math.max(margin, Math.min(top, view.innerHeight - height - margin))}px`;
  };
  const open = (): void => {
    cancelClose();
    if (button.hidden || button.disabled || !button.getClientRects().length) return;
    popover.hidden = false;
    if (!popover.matches(":popover-open")) popover.showPopover();
    position();
  };
  const scheduleClose = (): void => {
    cancelClose();
    // Let the pointer cross the gap into the help card without flickering.
    closeTimer = view.setTimeout(() => {
      closeTimer = undefined;
      if (
        !button.matches(":hover") &&
        !button.matches(":focus-visible") &&
        !popover.matches(":hover")
      ) {
        close();
      }
    }, 140);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") close();
  };
  const onPointerDown = (event: PointerEvent): void => {
    const path = event.composedPath();
    if (!path.includes(button) && !path.includes(popover)) close();
  };
  const onScroll = (event: Event): void => {
    if (!event.composedPath().includes(popover)) close();
  };
  const listeners = new AbortController();
  const options = { signal: listeners.signal };
  button.addEventListener("pointerenter", open, options);
  button.addEventListener("pointerleave", scheduleClose, options);
  button.addEventListener("focus", open, options);
  button.addEventListener("blur", scheduleClose, options);
  popover.addEventListener("pointerenter", cancelClose, options);
  popover.addEventListener("pointerleave", scheduleClose, options);
  document.addEventListener("keydown", onKeyDown, options);
  document.addEventListener("pointerdown", onPointerDown, options);
  view.addEventListener("resize", close, options);
  view.addEventListener("scroll", onScroll, { ...options, capture: true });

  return {
    render(message: string): void {
      const [title, ...detail] = message.split("\n");
      heading.textContent = title ?? "";
      description.textContent = detail.join("\n");
      if (button.hidden || button.disabled) close();
      else if (!popover.hidden) position();
    },
    close,
    dispose(): void {
      close();
      listeners.abort();
      button.removeAttribute("aria-describedby");
      popover.remove();
    },
  };
}
