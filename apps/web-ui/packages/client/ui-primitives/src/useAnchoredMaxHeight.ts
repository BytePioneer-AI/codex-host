/**
 * Viewport-fit hook for bottom-anchored overlays (slash menu, popupSelect):
 * the element's bottom edge is laid out independent of its height, so it
 * grows upward and only the top edge can collide with the viewport — clamp
 * the design cap to the space between that edge and the viewport top.
 */
import { useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { overlayTopMargin } from "./overlay-top-margin.ts";

/**
 * Safe distance kept between the overlay and the viewport top edge (mirrors
 * the Menu portal margin); the frame's overlay inset widens it.
 */
const MARGIN = 12;

/**
 * Clamp a bottom-anchored overlay's max-height to the viewport.
 * @param ref - the overlay element; a null current (overlay closed) skips measuring.
 * @param cap - design max-height in px (the clamp never exceeds it).
 * @param signal - re-measure trigger (e.g. open boolean or layout milestone);
 *   window resize, ancestor scroll, and anchor container resize re-fit while mounted.
 * @param margin - viewport top margin floor in px; the frame's overlay
 *   inset widens it. Callers under fixed chrome (the conversation header)
 *   raise it past their chrome's height.
 * @returns the max-height to apply inline, in px.
 */
export function useAnchoredMaxHeight(
  ref: RefObject<HTMLElement>,
  cap: number,
  signal: unknown,
  margin: number = MARGIN,
): number {
  const [maxHeight, setMaxHeight] = useState(cap);
  const bindingRef = useRef<{
    el: HTMLElement;
    cap: number;
    margin: number;
    fit: () => void;
    cleanup: () => void;
  } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    const current = bindingRef.current;
    if (el === null) {
      if (current !== null) {
        current.cleanup();
        bindingRef.current = null;
      }
      return;
    }
    if (current !== null && current.el === el && current.cap === cap && current.margin === margin) {
      current.fit();
      return;
    }
    current?.cleanup();
    const fit = () => {
      const next = Math.min(
        cap,
        Math.max(0, el.getBoundingClientRect().bottom - overlayTopMargin(margin)),
      );
      setMaxHeight((prev) => (prev === next ? prev : next));
    };
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && el.contains(event.target)) return;
      fit();
    };
    window.addEventListener("resize", fit);
    window.addEventListener("scroll", onScroll, true);
    let resizeObserver: ResizeObserver | undefined;
    const anchorTarget = el.closest("[data-composer-card]") ?? el.parentElement;
    if (anchorTarget !== null && typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(fit);
      resizeObserver.observe(anchorTarget);
    }
    const cleanup = () => {
      window.removeEventListener("resize", fit);
      window.removeEventListener("scroll", onScroll, true);
      resizeObserver?.disconnect();
    };
    bindingRef.current = { el, cap, margin, fit, cleanup };
    fit();
  }, [ref, cap, signal, margin]);

  useLayoutEffect(
    () => () => {
      bindingRef.current?.cleanup();
      bindingRef.current = null;
    },
    [],
  );

  return maxHeight;
}
