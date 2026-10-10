import type { KeyboardEvent } from "react";

/** Only real, visible navigation rows; exit-animation clones are outside this tree. */
function rowsIn(tree: HTMLElement): HTMLElement[] {
  return [...tree.querySelectorAll<HTMLElement>("[data-row-key]")].filter(
    (row) => row.offsetHeight > 0 && !row.closest("[inert]"),
  );
}

/** One Tab entry per tree. Tab within a focused row still reaches its actions. */
export function syncSidebarTabStop(tree: HTMLElement | null): void {
  if (!tree) return;
  const rows = rowsIn(tree);
  const focused = document.activeElement?.closest<HTMLElement>("[data-row-key]");
  const entry =
    rows.find((row) => row === focused) ??
    rows.find((row) => row.getAttribute("aria-selected") === "true") ??
    rows[0];
  for (const row of rows) row.tabIndex = row === entry ? 0 : -1;
}

/** Focus movement does not select or read a Thread until Enter/Space activates it. */
export function navigateSidebar(event: KeyboardEvent<HTMLDivElement>): void {
  if (
    event.defaultPrevented ||
    event.nativeEvent.isComposing ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  )
    return;
  const tree = event.currentTarget;
  const row = event.target;
  // Menu buttons and portaled menu items own their keyboard behavior.
  if (!(row instanceof HTMLElement) || !row.matches("[data-row-key]") || !tree.contains(row))
    return;
  const rows = rowsIn(tree);
  const index = rows.indexOf(row);
  if (index < 0) return;
  const groupRow = row.matches('[role="treeitem"][aria-expanded]');
  let next: HTMLElement | undefined;
  switch (event.key) {
    case "ArrowDown":
      next = rows[index + 1];
      break;
    case "ArrowUp":
      next = rows[index - 1];
      break;
    case "Home":
      next = rows[0];
      break;
    case "End":
      next = rows.at(-1);
      break;
    case "ArrowRight":
      if (groupRow && row.getAttribute("aria-expanded") === "false") row.click();
      else if (groupRow) next = rows[index + 1];
      break;
    case "ArrowLeft": {
      if (groupRow && row.getAttribute("aria-expanded") === "true") row.click();
      else {
        let group = row.closest("[data-sidebar-group]");
        let heading = group?.querySelector<HTMLElement>('[data-row-key^="workspace:"]');
        if (heading === row) {
          group = group?.parentElement?.closest("[data-sidebar-group]") ?? null;
          heading = group?.querySelector<HTMLElement>('[data-row-key^="workspace:"]');
        }
        next = heading ?? undefined;
      }
      break;
    }
    case "Enter":
    case " ":
      row.click();
      break;
    default:
      return;
  }
  event.preventDefault();
  if (next) {
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: "nearest" });
    syncSidebarTabStop(tree);
  }
}
