/** Local phone drawer spring and direct manipulation. No Thread state. */
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { isPhoneSidebarGestureTarget } from "./phone-sidebar-swipe.ts";

export function usePhoneDrawerMotion(
  frame: RefObject<HTMLDivElement | null>,
  drawer: RefObject<HTMLDivElement | null>,
  backdrop: RefObject<HTMLButtonElement | null>,
  enabled: boolean,
  open: boolean,
  onOpenChange: (open: boolean) => void,
) {
  const [present, setPresent] = useState(open && enabled);
  const controls = useRef<{ target: (open: boolean) => void } | null>(null);
  const change = useRef(onOpenChange);
  change.current = onOpenChange;
  const requested = useRef(open);
  requested.current = open;

  useLayoutEffect(() => {
    const root = frame.current;
    const element = drawer.current;
    const mask = backdrop.current;
    if (!enabled || root === null || element === null || mask === null) {
      setPresent(false);
      return;
    }
    const edge = element.querySelector<HTMLElement>("[data-phone-drawer-edge]");
    if (edge === null) return;
    const document = root.ownerDocument;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let width = element.offsetWidth;
    let x = requested.current ? 0 : -width;
    let velocity = 0;
    let target = x;
    let raf: number | null = null;
    let last = 0;
    let suppressClick = false;
    let gesture: {
      id: number;
      kind: "touch" | "pointer";
      x: number;
      y: number;
      base: number;
      open: boolean;
      opening: boolean;
      claimed: boolean;
      samples: { x: number; time: number }[];
    } | null = null;
    const paint = () => {
      element.style.transform = `translateX(${x}px)`;
      const visible = x > -width + 0.5 || target === 0 || gesture?.claimed === true;
      element.style.visibility = visible ? "visible" : "hidden";
      // The visible gutter stays grabbable even while a rejected preview settles.
      // AppFrame keeps its content inert until the open state is committed.
      element.inert = !visible;
      mask.style.visibility = visible ? "visible" : "hidden";
      mask.style.opacity = String(Math.max(0, Math.min(1, 1 + x / width)));
    };
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
        x = Math.max(-width, Math.min(0, x + velocity * step));
        dt -= step;
      }
      if (Math.abs(target - x) < 0.1 && Math.abs(velocity) < 1) {
        x = target;
        velocity = 0;
        last = 0;
        setPresent(target === 0);
      } else raf = requestAnimationFrame(tick);
      paint();
    };
    const animate = (nextOpen: boolean) => {
      if (gesture !== null) return;
      width = element.offsetWidth;
      target = nextOpen ? 0 : -width;
      // A closed-state preview stays inert and outside the modal/focus lifetime.
      if (nextOpen) setPresent(true);
      if (reduced.matches) {
        stop();
        x = target;
        velocity = 0;
        setPresent(nextOpen);
        paint();
      } else {
        paint();
        raf ??= requestAnimationFrame(tick);
      }
    };
    const release = () => {
      const active = gesture;
      gesture = null;
      if (active?.claimed) suppressClick = true;
      if (active?.kind === "pointer" && edge.hasPointerCapture(active.id))
        edge.releasePointerCapture(active.id);
    };
    const cancel = () => {
      if (gesture === null) return;
      release();
      velocity = 0;
      animate(requested.current);
    };
    const available = () =>
      document.getSelection()?.isCollapsed !== false &&
      [...document.querySelectorAll('[aria-modal="true"], [role="menu"], dialog[open]')].every(
        (layer) =>
          layer === element ||
          (element.contains(layer) &&
            (layer.hasAttribute("data-phone-sidebar-view") ||
              (layer.getAttribute("role") === "menu" &&
                layer.closest("[data-phone-sidebar-view]") !== null))),
      );
    const begin = (
      id: number,
      kind: "touch" | "pointer",
      clientX: number,
      clientY: number,
      time: number,
      opening: boolean,
    ) => {
      stop();
      velocity = 0;
      gesture = {
        id,
        kind,
        x: clientX,
        y: clientY,
        base: x,
        open: requested.current,
        opening,
        claimed: false,
        samples: [{ x, time }],
      };
    };
    const dragTo = (clientX: number, time: number) => {
      const active = gesture;
      if (active === null) return;
      x = Math.max(-width, Math.min(0, active.base + clientX - active.x));
      active.samples.push({ x, time });
      active.samples = active.samples.filter((sample) => time - sample.time <= 90);
      paint();
    };
    const move = (clientX: number, clientY: number, event: TouchEvent | PointerEvent) => {
      const active = gesture;
      if (active === null) return;
      if (!available()) return cancel();
      const dx = clientX - active.x;
      const dy = Math.abs(clientY - active.y);
      if (!active.claimed) {
        if ((dy > 8 && dy >= Math.abs(dx) / 1.5) || (active.opening && dx < -8)) return cancel();
        if ((active.opening ? dx : Math.abs(dx)) < 8 || Math.abs(dx) < dy * 1.5) return;
        if (!event.cancelable) return cancel();
        active.claimed = true;
        if (active.kind === "pointer") edge.setPointerCapture(active.id);
      }
      if (!event.cancelable) return cancel();
      event.preventDefault();
      dragTo(clientX, event.timeStamp);
    };
    const finish = (clientX: number, event: TouchEvent | PointerEvent) => {
      const active = gesture;
      if (active === null) return;
      if (!active.claimed || !available()) return cancel();
      if (event.cancelable) event.preventDefault();
      dragTo(clientX, event.timeStamp);
      const first = active.samples[0];
      velocity =
        first && event.timeStamp > first.time
          ? ((x - first.x) / (event.timeStamp - first.time)) * 1000
          : 0;
      const nextOpen = x + velocity * 0.15 > -width * 0.5;
      release();
      change.current(nextOpen);
      animate(nextOpen);
    };

    // Touch Events let opening gestures yield to native scrolling without
    // changing touch-action on the conversation or covering it with a hit layer.
    const touchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) return cancel();
      suppressClick = false;
      if (gesture !== null || !available()) return;
      const origin = event.target;
      if (!(origin instanceof Element) || !root.contains(origin)) return;
      const touch = event.touches[0]!;
      const closing = edge.contains(origin) || origin === mask;
      if (!closing) {
        if (
          !root.hasAttribute("data-sidebar-collapsed") ||
          !isPhoneSidebarGestureTarget(root, origin) ||
          origin.closest('[role="button"], label, [data-sidebar-right-panel]')
        )
          return;
      }
      begin(touch.identifier, "touch", touch.clientX, touch.clientY, event.timeStamp, !closing);
    };
    const touchMove = (event: TouchEvent) => {
      if (gesture?.kind !== "touch") return;
      const touch = event.touches[0];
      if (event.touches.length !== 1 || touch?.identifier !== gesture.id) return cancel();
      move(touch.clientX, touch.clientY, event);
    };
    const touchEnd = (event: TouchEvent) => {
      if (gesture?.kind !== "touch") return;
      const touch = [...event.changedTouches].find((touch) => touch.identifier === gesture?.id);
      if (event.touches.length !== 0 || touch === undefined) return cancel();
      finish(touch.clientX, event);
    };
    const pointerDown = (event: PointerEvent) => {
      if (event.pointerType === "touch") {
        if (gesture?.kind === "pointer") cancel();
        return;
      }
      if (gesture !== null && (gesture.kind !== "pointer" || gesture.id !== event.pointerId))
        cancel();
      suppressClick = false;
      if (
        !event.isPrimary ||
        event.button !== 0 ||
        gesture !== null ||
        !(event.target instanceof Node) ||
        !edge.contains(event.target) ||
        !available()
      )
        return;
      begin(event.pointerId, "pointer", event.clientX, event.clientY, event.timeStamp, false);
      edge.setPointerCapture(event.pointerId);
    };
    const pointerMove = (event: PointerEvent) => {
      if (gesture?.kind === "pointer" && gesture.id === event.pointerId)
        move(event.clientX, event.clientY, event);
    };
    const pointerUp = (event: PointerEvent) => {
      if (gesture?.kind === "pointer" && gesture.id === event.pointerId)
        finish(event.clientX, event);
    };
    const pointerCancel = (event: PointerEvent) => {
      if (
        (gesture?.kind === "pointer" && gesture.id === event.pointerId) ||
        (gesture?.kind === "touch" && event.pointerType === "touch")
      )
        cancel();
    };
    const lostCapture = (event: PointerEvent) => {
      if (gesture?.kind === "pointer" && gesture.id === event.pointerId) cancel();
    };
    const click = (event: MouseEvent) => {
      if (gesture?.claimed || (suppressClick && event.detail !== 0)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    const preference = () => animate(requested.current);
    const resize = new ResizeObserver(() => {
      if (element.offsetWidth === width) return;
      cancel();
      animate(requested.current);
    });
    resize.observe(element);
    controls.current = {
      target: (nextOpen) => {
        if (gesture !== null && gesture.open !== nextOpen) cancel();
        animate(nextOpen);
      },
    };
    paint();
    setPresent(requested.current);
    // Document starts also detect a second contact outside the frame; no default is blocked.
    document.addEventListener("touchstart", touchStart, { passive: true, capture: true });
    document.addEventListener("pointerdown", pointerDown, true);
    root.addEventListener("touchmove", touchMove, { passive: false, capture: true });
    root.addEventListener("touchend", touchEnd, { passive: false, capture: true });
    root.addEventListener("touchcancel", cancel, true);
    root.addEventListener("click", click, true);
    edge.addEventListener("pointermove", pointerMove);
    edge.addEventListener("pointerup", pointerUp);
    root.addEventListener("pointercancel", pointerCancel, true);
    edge.addEventListener("lostpointercapture", lostCapture);
    reduced.addEventListener("change", preference);
    return () => {
      controls.current = null;
      release();
      stop();
      resize.disconnect();
      reduced.removeEventListener("change", preference);
      document.removeEventListener("touchstart", touchStart, true);
      document.removeEventListener("pointerdown", pointerDown, true);
      root.removeEventListener("touchmove", touchMove, true);
      root.removeEventListener("touchend", touchEnd, true);
      root.removeEventListener("touchcancel", cancel, true);
      root.removeEventListener("click", click, true);
      edge.removeEventListener("pointermove", pointerMove);
      edge.removeEventListener("pointerup", pointerUp);
      root.removeEventListener("pointercancel", pointerCancel, true);
      edge.removeEventListener("lostpointercapture", lostCapture);
    };
  }, [enabled, frame, drawer, backdrop]);

  useLayoutEffect(() => {
    controls.current?.target(open);
  }, [open, enabled]);
  return enabled && present;
}
