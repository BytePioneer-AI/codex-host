/**
 * A hairline under a horizontally scrolling row. It is drawn only while the row overflows, shows
 * where the visible part sits, and can be dragged; the native scrollbar stays hidden because an
 * overlay scrollbar covers the row's content.
 */
export function createHorizontalScrollHint(
  document: Document,
  scroller: HTMLElement,
  className: string,
): { element: HTMLElement; update: () => void } {
  const element = document.createElement("div");
  element.className = className;
  // Pointer-only affordance: keyboard and assistive technology reach the row's own controls.
  element.setAttribute("aria-hidden", "true");
  const thumb = document.createElement("span");
  element.append(thumb);

  const limit = (): number => Math.max(0, scroller.scrollWidth - scroller.clientWidth);
  const scrollTo = (left: number): void => {
    scroller.scrollLeft = Math.min(limit(), Math.max(0, left));
    update();
  };
  const update = (): void => {
    const { clientWidth, scrollLeft, scrollWidth } = scroller;
    const overflowing = scrollWidth > clientWidth + 1;
    element.dataset.overflowing = String(overflowing);
    if (!overflowing) return;
    thumb.style.width = `${(clientWidth / scrollWidth) * 100}%`;
    thumb.style.left = `${(scrollLeft / scrollWidth) * 100}%`;
  };

  scroller.addEventListener("scroll", update, { passive: true });
  scroller.addEventListener(
    "wheel",
    (event) => {
      // A plain mouse wheel only scrolls vertically; let it move the row while there is
      // somewhere to go, and leave the page scrolling alone at either end.
      if (event.deltaX !== 0 || event.deltaY === 0 || event.ctrlKey) return;
      const next = Math.min(limit(), Math.max(0, scroller.scrollLeft + event.deltaY));
      if (Math.abs(next - scroller.scrollLeft) < 1) return;
      event.preventDefault();
      scrollTo(next);
    },
    { passive: false },
  );

  let drag: { pointerId: number; startX: number; startLeft: number; scale: number } | null = null;
  element.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || limit() <= 1) return;
    const track = element.getBoundingClientRect();
    if (track.width <= 0) return;
    // Pressing the line beside the thumb first brings the thumb under the pointer.
    if (event.target !== thumb) {
      const pointed = ((event.clientX - track.left) / track.width) * scroller.scrollWidth;
      scrollTo(pointed - scroller.clientWidth / 2);
    }
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startLeft: scroller.scrollLeft,
      // One pixel along the line is this many pixels of row content.
      scale: scroller.scrollWidth / track.width,
    };
    element.dataset.dragging = "true";
    // Keep receiving moves when the pointer leaves the thin line.
    element.setPointerCapture(event.pointerId);
    // No text selection or native drag while moving the thumb.
    event.preventDefault();
  });
  element.addEventListener("pointermove", (event) => {
    if (drag?.pointerId !== event.pointerId) return;
    scrollTo(drag.startLeft + (event.clientX - drag.startX) * drag.scale);
  });
  const release = (event: PointerEvent): void => {
    if (drag?.pointerId !== event.pointerId) return;
    drag = null;
    delete element.dataset.dragging;
  };
  element.addEventListener("pointerup", release);
  element.addEventListener("pointercancel", release);

  const ResizeObserverClass = document.defaultView?.ResizeObserver;
  if (ResizeObserverClass) new ResizeObserverClass(update).observe(scroller);
  return { element, update };
}
