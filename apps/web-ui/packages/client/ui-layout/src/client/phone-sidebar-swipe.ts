/** Shared start-target guard; right-panel return gestures also allow buttons. */
export function isPhoneSidebarGestureTarget(
  frame: HTMLElement,
  target: Element,
  allowButtons = false,
  point?: { x: number; y: number },
): boolean {
  if (!frame.contains(target)) return false;
  if (
    target.closest(
      'input, textarea, select, a, [contenteditable]:not([contenteditable="false"]), [role="slider"], [data-phone-drawer], canvas, iframe, video, [data-sidebar-terminal], [data-dockkit-host="float"], [data-dockkit-divider], [data-dockkit-strip-tabs]',
    ) ||
    (!allowButtons && target.closest("button, [data-sidebar-right-session]"))
  )
    return false;
  for (
    let node: Element | null = target;
    node !== null && node !== frame;
    node = node.parentElement
  ) {
    const overflow = getComputedStyle(node).overflowX;
    if (node.scrollWidth > node.clientWidth + 1 && /^(auto|scroll)$/.test(overflow)) return false;
  }
  // Inert content retargets touches to its moving background. Keep its protected
  // regions excluded when grabbing a closing panel, even though they cannot focus.
  if (point !== undefined) {
    for (const child of target.querySelectorAll("[inert], [inert] *")) {
      const rect = child.getBoundingClientRect();
      if (
        rect.width > 0 &&
        rect.height > 0 &&
        point.x >= rect.left &&
        point.x <= rect.right &&
        point.y >= rect.top &&
        point.y <= rect.bottom &&
        !isPhoneSidebarGestureTarget(frame, child, allowButtons)
      )
        return false;
    }
  }
  return true;
}

/** Single-finger navigation that yields to scrolling, editing and content-owned gestures. */
export function bindPhoneSidebarSwipe(
  frame: HTMLElement,
  direction: "left" | "right",
  navigate: () => void,
  surface: "main" | "rightbar" = "main",
): () => void {
  let gesture: {
    id: number;
    x: number;
    y: number;
    started: number;
    claimed: boolean;
    target: Element;
  } | null = null;
  const inRightbar = (target: Element): boolean => {
    const panel = target.closest("[data-sidebar-right-panel][data-sidebar-right-open]");
    return panel !== null && panel.closest("[hidden]") === null;
  };
  const reset = (): void => {
    gesture = null;
  };
  const available = (): boolean =>
    frame.hasAttribute("data-phone") &&
    frame.hasAttribute("data-sidebar-collapsed") &&
    frame.ownerDocument.querySelector('[aria-modal="true"], [role="menu"]') === null &&
    frame.ownerDocument.getSelection()?.isCollapsed !== false;
  const onStart = (event: TouchEvent): void => {
    reset();
    if (event.touches.length !== 1 || !available()) return;
    const target = event.target;
    if (
      !(target instanceof Element) ||
      !isPhoneSidebarGestureTarget(frame, target, surface === "rightbar")
    )
      return;
    if (surface === "rightbar" && !inRightbar(target)) return;
    const touch = event.touches[0]!;
    gesture = {
      id: touch.identifier,
      x: touch.clientX,
      y: touch.clientY,
      started: event.timeStamp,
      claimed: false,
      target,
    };
  };
  const onMove = (event: TouchEvent): void => {
    if (gesture === null) return;
    // A direct drawer drag owns this sequence, including a later direction reversal.
    if (event.defaultPrevented) return reset();
    if (frame.ownerDocument.getSelection()?.isCollapsed === false) return reset();
    const touch = event.touches[0];
    if (event.touches.length !== 1 || touch?.identifier !== gesture.id) return reset();
    const dx = (touch.clientX - gesture.x) * (direction === "right" ? 1 : -1);
    const dy = Math.abs(touch.clientY - gesture.y);
    if (!gesture.claimed) {
      if ((dy > 12 && dy >= Math.abs(dx) / 1.5) || dx < -12) return reset();
      if (dx < 16 || dx < dy * 1.5) return;
      gesture.claimed = true;
    }
    if (event.cancelable) event.preventDefault();
    else reset();
  };
  const onEnd = (event: TouchEvent): void => {
    const active = gesture;
    reset();
    if (
      event.defaultPrevented ||
      active === null ||
      !active.claimed ||
      event.touches.length !== 0 ||
      !available()
    )
      return;
    if (!frame.contains(active.target) || (surface === "rightbar" && !inRightbar(active.target)))
      return;
    const touch = Array.from(event.changedTouches).find((touch) => touch.identifier === active.id);
    if (touch === undefined) return;
    const dx = (touch.clientX - active.x) * (direction === "right" ? 1 : -1);
    const dy = Math.abs(touch.clientY - active.y);
    if (dx >= 64 && dx >= dy * 1.5 && event.timeStamp - active.started <= 700) navigate();
  };
  frame.addEventListener("touchstart", onStart, { passive: true });
  frame.addEventListener("touchmove", onMove, { passive: false });
  frame.addEventListener("touchend", onEnd, { passive: true });
  frame.addEventListener("touchcancel", reset, { passive: true });
  return () => {
    reset();
    frame.removeEventListener("touchstart", onStart);
    frame.removeEventListener("touchmove", onMove);
    frame.removeEventListener("touchend", onEnd);
    frame.removeEventListener("touchcancel", reset);
  };
}
