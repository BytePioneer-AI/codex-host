/** Phone-only right-panel tracking. The panel owner paints only its docked surface. */
import type { RightbarOwnerProps } from "./index.ts";
import { PHONE_BREAKPOINT } from "./columns.ts";
import { isPhoneSidebarGestureTarget } from "./phone-sidebar-swipe.ts";

export function bindPhoneRightbarMotion(
  frame: HTMLElement,
  surface: Parameters<RightbarOwnerProps["bindSwipeNavigation"]>[0],
): ReturnType<RightbarOwnerProps["bindSwipeNavigation"]> {
  const { element, paint, onExpandedChange } = surface;
  const document = frame.ownerDocument;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let expanded = surface.expanded;
  let width = element.offsetWidth;
  let frameWidth = frame.getBoundingClientRect().width;
  let x = expanded ? 0 : width;
  let target = x;
  let velocity = 0;
  let raf: number | null = null;
  let last = 0;
  let suppressClick = false;
  let gesture: {
    id: number;
    x: number;
    y: number;
    base: number;
    opening: boolean;
    interrupting: boolean;
    claimed: boolean;
    origin: Element;
    samples: { x: number; time: number }[];
  } | null = null;
  const render = () => paint(x, x < width - 0.5 || target === 0 || gesture?.claimed === true);
  const stop = () => {
    if (raf !== null) cancelAnimationFrame(raf);
    raf = null;
    last = 0;
  };
  const tick = (time: number) => {
    raf = null;
    let dt = last === 0 ? 1 / 60 : Math.min((time - last) / 1000, 0.032);
    last = time;
    while (dt > 0) {
      const step = Math.min(dt, 1 / 120);
      velocity += ((target - x) * 400 - 40 * velocity) * step;
      x = Math.max(0, Math.min(width, x + velocity * step));
      dt -= step;
    }
    if (Math.abs(target - x) < 0.1 && Math.abs(velocity) < 1) {
      x = target;
      velocity = 0;
      last = 0;
    } else raf = requestAnimationFrame(tick);
    render();
  };
  const settle = () => {
    target = expanded ? 0 : width;
    if (reduced.matches) {
      stop();
      x = target;
      velocity = 0;
    } else raf ??= requestAnimationFrame(tick);
    render();
  };
  const cancel = () => {
    if (gesture === null) return;
    suppressClick ||= gesture.claimed;
    gesture = null;
    velocity = 0;
    settle();
  };
  const available = () =>
    frame.hasAttribute("data-phone") &&
    frame.getBoundingClientRect().width < PHONE_BREAKPOINT &&
    frame.hasAttribute("data-sidebar-collapsed") &&
    element.isConnected &&
    element.closest("[hidden]") === null &&
    document.querySelector('[aria-modal="true"], [role="menu"], dialog[open]') === null &&
    document.getSelection()?.isCollapsed !== false;
  const start = (event: TouchEvent) => {
    if (event.touches.length !== 1) return cancel();
    suppressClick = false;
    if (gesture !== null || !available()) return;
    const origin = event.target;
    if (!(origin instanceof Element)) return;
    const closing = element.contains(origin);
    const touch = event.touches[0]!;
    if (
      !isPhoneSidebarGestureTarget(
        frame,
        origin,
        closing,
        closing ? { x: touch.clientX, y: touch.clientY } : undefined,
      ) ||
      (!closing && (expanded || origin.closest('[role="button"], label'))) ||
      (closing && x >= width - 0.5)
    )
      return;
    stop();
    velocity = 0;
    gesture = {
      id: touch.identifier,
      x: touch.clientX,
      y: touch.clientY,
      base: x,
      opening: !closing,
      interrupting: closing && x > 0 && x < width,
      claimed: false,
      origin,
      samples: [{ x, time: event.timeStamp }],
    };
  };
  const dragTo = (clientX: number, time: number) => {
    if (gesture === null) return;
    x = Math.max(0, Math.min(width, gesture.base + clientX - gesture.x));
    gesture.samples.push({ x, time });
    gesture.samples = gesture.samples.filter((sample) => time - sample.time <= 90);
    render();
  };
  const move = (event: TouchEvent) => {
    const active = gesture;
    if (active === null) return;
    const touch = event.touches[0];
    if (
      event.defaultPrevented ||
      event.touches.length !== 1 ||
      touch?.identifier !== active.id ||
      !available() ||
      !frame.contains(active.origin)
    )
      return cancel();
    const dx = touch.clientX - active.x;
    const dy = Math.abs(touch.clientY - active.y);
    if (!active.claimed) {
      const forward = active.opening ? -dx : dx;
      if ((dy > 8 && dy >= Math.abs(dx) / 1.5) || (!active.interrupting && forward < -8))
        return cancel();
      if ((active.interrupting ? Math.abs(dx) : forward) < 8 || Math.abs(dx) < dy * 1.5) return;
      active.claimed = true;
    }
    if (!event.cancelable) return cancel();
    event.preventDefault();
    dragTo(touch.clientX, event.timeStamp);
  };
  const end = (event: TouchEvent) => {
    const active = gesture;
    if (active === null) return;
    const touch = [...event.changedTouches].find((touch) => touch.identifier === active.id);
    if (
      !active.claimed ||
      event.defaultPrevented ||
      event.touches.length !== 0 ||
      touch === undefined ||
      !available() ||
      !frame.contains(active.origin)
    )
      return cancel();
    if (event.cancelable) event.preventDefault();
    dragTo(touch.clientX, event.timeStamp);
    const first = active.samples[0];
    velocity =
      first && event.timeStamp > first.time
        ? ((x - first.x) / (event.timeStamp - first.time)) * 1000
        : 0;
    const nextOpen = x + velocity * 0.15 < width * 0.5;
    gesture = null;
    suppressClick = true;
    // Previews never write the business state; only a valid release asks its owner.
    if (expanded !== nextOpen) onExpandedChange(nextOpen);
    expanded = nextOpen;
    settle();
  };
  const click = (event: MouseEvent) => {
    if (event.detail !== 0 && (gesture?.claimed || suppressClick)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  const pointerStart = (event: PointerEvent) => {
    if (event.pointerType !== "touch" && gesture === null) suppressClick = false;
  };
  const preference = () => {
    if (gesture === null) settle();
  };
  const resize = new ResizeObserver(() => {
    const nextFrameWidth = frame.getBoundingClientRect().width;
    if (width === element.offsetWidth && frameWidth === nextFrameWidth) return;
    cancel();
    stop();
    frameWidth = nextFrameWidth;
    width = element.offsetWidth;
    x = expanded ? 0 : width;
    velocity = 0;
    target = x;
    render();
  });
  resize.observe(element);
  resize.observe(frame);
  // Menus can be portalled outside the frame and appear without another touch move.
  const layers = new MutationObserver(() => {
    if (gesture !== null && (!available() || !frame.contains(gesture.origin))) cancel();
  });
  layers.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["aria-modal", "role", "open", "hidden", "data-sidebar-collapsed"],
  });
  render();
  document.addEventListener("touchstart", start, { passive: true, capture: true });
  document.addEventListener("pointerdown", pointerStart, true);
  frame.addEventListener("touchmove", move, { passive: false, capture: true });
  frame.addEventListener("touchend", end, { passive: false, capture: true });
  frame.addEventListener("touchcancel", cancel, true);
  frame.addEventListener("click", click, true);
  reduced.addEventListener("change", preference);
  return {
    setExpanded(nextOpen) {
      if (expanded === nextOpen) return render();
      expanded = nextOpen;
      if (gesture !== null) cancel();
      else settle();
    },
    dispose() {
      gesture = null;
      stop();
      resize.disconnect();
      layers.disconnect();
      reduced.removeEventListener("change", preference);
      document.removeEventListener("touchstart", start, true);
      document.removeEventListener("pointerdown", pointerStart, true);
      frame.removeEventListener("touchmove", move, true);
      frame.removeEventListener("touchend", end, true);
      frame.removeEventListener("touchcancel", cancel, true);
      frame.removeEventListener("click", click, true);
      paint(null, false);
    },
  };
}
