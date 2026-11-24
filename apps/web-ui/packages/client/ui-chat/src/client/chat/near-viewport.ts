/**
 * Marks transcript rows that lie within one scrollport height of the visible
 * transcript. Wallpaper blur is styled only inside marked rows: while the
 * filter stays applied, WebKit retains the backing stores of backdrop-filter
 * layers composited during fast scrolling or streaming, so blur on the whole
 * transcript grows graphics memory with the rows scrolled past.
 */
import { useLayoutEffect, type RefObject } from "react";

const NEAR_VIEWPORT_ATTRIBUTE = "data-chat-near-viewport";

/** One observer per conversation scrollport, shared by all of its rows. */
const observers = new WeakMap<Element, IntersectionObserver>();

function observerFor(scrollport: Element): IntersectionObserver {
  let observer = observers.get(scrollport);
  if (observer === undefined) {
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          entry.target.toggleAttribute(NEAR_VIEWPORT_ATTRIBUTE, entry.isIntersecting);
      },
      { root: scrollport, rootMargin: "100% 0px" },
    );
    observers.set(scrollport, observer);
  }
  return observer;
}

/**
 * Keep the near-viewport mark on one top-level row current.
 * A row starts marked, so one that mounts in view is blurred on its first
 * paint; its first observation then clears the mark when it is far away.
 * Process-group members carry no mark: their group is the row, and the
 * group's capped body would clip their own observation. A transcript outside
 * a shared conversation scrollport keeps every row marked.
 * @param ref - the Node Seat or Group Seat element.
 * @param rendered - whether the Seat element is currently rendered.
 */
export function useNearViewport(ref: RefObject<Element>, rendered: boolean): void {
  useLayoutEffect(() => {
    const row = ref.current;
    if (row === null || row.matches("[data-chat-flow-key] *")) return;
    row.setAttribute(NEAR_VIEWPORT_ATTRIBUTE, "");
    const scrollport = row.closest("[data-conversation-scroll]");
    if (scrollport === null) return;
    const observer = observerFor(scrollport);
    observer.observe(row);
    return () => {
      observer.unobserve(row);
    };
  }, [ref, rendered]);
}
