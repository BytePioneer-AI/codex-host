/** Same input-capability rule as the sidebar/Rows touch actions; width alone is not a phone. */
import { useSyncExternalStore } from "react";

const query = "(hover: none), (pointer: coarse)";
function subscribe(listener: () => void): () => void {
  const media = window.matchMedia(query);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}
function snapshot(): boolean {
  return window.matchMedia(query).matches;
}
export function useSidebarTouch(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
