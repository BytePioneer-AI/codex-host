/**
 * Expand and collapse motion for the sidebar Thread tree, after the Web sidebar's
 * `AnimatedRows`: rows that appear fade in, rows that move glide to their new place, and rows
 * that leave fade out in an inert overlay. It runs only for a toggle the user made, and not at
 * all under `prefers-reduced-motion`.
 *
 * Moving rows are the codexhost rows in the toggled listitem, with their summary lines, and the
 * blocks after that listitem. Blocks Desktop moves itself, such as the projects below a project
 * list, have not moved yet when the new layout is read, so they are left to Desktop.
 *
 * Desktop animates a project list's height with its own curve, clipping what lies outside it, so
 * rows glide on that curve: rows inside the list then keep pace with the list and the projects
 * below it instead of being clipped while the list closes.
 */

export const SIDEBAR_TREE_MOTION_ATTRIBUTE = "data-codexhost-sidebar-tree-motion";

const ROW_FADE_MS = 100;
/** Desktop's collapsible sidebar sections: 300ms on cubic-bezier(0.19, 1, 0.22, 1). */
const ROW_GLIDE_MS = 300;
const ROW_GLIDE_EASING = "cubic-bezier(0.19, 1, 0.22, 1)";
const SCROLL_SELECTOR = "[data-app-action-sidebar-scroll]";
const ROW_KEY_ATTRIBUTE = "data-codexhost-sidebar-tree-key";
const ROW_SELECTOR = `[${ROW_KEY_ATTRIBUTE}^="row:"], [${ROW_KEY_ATTRIBUTE}^="summary:"]`;
/** What a codexhost row inherits from its container; a clone outside it needs them inline. */
const INHERITED_PROPERTIES = [
  "--cxh-icon-left",
  "--cxh-indent",
  "--cxh-row-h",
  "--cxh-row-radius",
  "--cxh-row-pad-end",
  "--cxh-title-gap",
  "--cxh-title-size",
  "--cxh-title-line",
  "--cxh-title-weight",
  "--cxh-title-color",
  "--cxh-summary-start",
  "font-family",
  "color",
];

interface RowPosition {
  rect: DOMRect;
  /** Set when the row was on screen, to fade out if it leaves. */
  clone: HTMLElement | null;
}

export interface SidebarThreadTreeMotion {
  item: HTMLElement;
  viewport: HTMLElement;
  rows: Map<string, RowPosition>;
  blocks: Map<HTMLElement, DOMRect>;
}

/**
 * A row's summary line is part of that row, as it is inside the row on the Web: it arrives and
 * leaves with the row, and appears or goes without motion when only the row's fold changes.
 */
function ownerRowKey(key: string): string | null {
  return key.startsWith("summary:") ? `row:${key.slice("summary:".length)}` : null;
}

const movements = new Map<Element, Animation>();
const exits = new Set<HTMLElement>();

function intersects(rect: DOMRect, viewport: DOMRect): boolean {
  return (
    rect.height > 0 &&
    rect.bottom > viewport.top &&
    rect.top < viewport.bottom &&
    rect.right > viewport.left &&
    rect.left < viewport.right
  );
}

/** Elements that move as one block; `display: contents` has no box, so its children do. */
function collectBlocks(
  element: Element,
  view: Window & typeof globalThis,
  out: Map<HTMLElement, DOMRect>,
): void {
  if (!(element instanceof view.HTMLElement) || element.hasAttribute(SIDEBAR_TREE_MOTION_ATTRIBUTE))
    return;
  if (view.getComputedStyle(element).display === "contents") {
    for (const child of element.children) collectBlocks(child, view, out);
    return;
  }
  out.set(element, element.getBoundingClientRect());
}

/** Records where things are before a toggle in `item`; null when nothing should animate. */
export function captureSidebarThreadTreeMotion(item: HTMLElement): SidebarThreadTreeMotion | null {
  const view = item.ownerDocument.defaultView;
  const viewport = item.closest<HTMLElement>(SCROLL_SELECTOR);
  if (
    !view ||
    !viewport ||
    typeof item.animate !== "function" ||
    view.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  )
    return null;
  const bounds = viewport.getBoundingClientRect();
  const rows = new Map<string, RowPosition>();
  for (const element of item.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
    const key = element.getAttribute(ROW_KEY_ATTRIBUTE);
    if (!key) continue;
    const rect = element.getBoundingClientRect();
    let clone: HTMLElement | null = null;
    if (intersects(rect, bounds)) {
      clone = element.cloneNode(true) as HTMLElement;
      // A picture of the row: nothing in it may be found as a row, a control or a cycle stop.
      for (const attribute of [...clone.attributes]) {
        const name = attribute.name;
        if (
          name.startsWith("data-") ||
          name.startsWith("aria-") ||
          name === "tabindex" ||
          name === "role"
        )
          clone.removeAttribute(name);
      }
      clone.inert = true;
      const style = view.getComputedStyle(element);
      for (const name of INHERITED_PROPERTIES)
        clone.style.setProperty(name, style.getPropertyValue(name));
      clone.style.opacity = style.opacity;
    }
    rows.set(key, { rect, clone });
  }
  const blocks = new Map<HTMLElement, DOMRect>();
  for (let node: HTMLElement | null = item; node && node !== viewport; node = node.parentElement) {
    for (let sibling = node.nextElementSibling; sibling; sibling = sibling.nextElementSibling)
      collectBlocks(sibling, view, blocks);
  }
  return { item, viewport, rows, blocks };
}

function move(
  element: Element,
  keyframes: Keyframe[],
  duration: number,
  easing = "ease-out",
): void {
  const animation = element.animate(keyframes, { duration, easing });
  movements.set(element, animation);
  animation.onfinish = () => {
    if (movements.get(element) === animation) movements.delete(element);
    animation.cancel();
  };
}

function glide(element: Element, from: DOMRect, to: DOMRect): void {
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  if (dx === 0 && dy === 0) return;
  move(
    element,
    [
      { transform: `translate(${String(dx)}px, ${String(dy)}px)` },
      { transform: "translate(0, 0)" },
    ],
    ROW_GLIDE_MS,
    ROW_GLIDE_EASING,
  );
}

function clips(overflow: string): boolean {
  return overflow !== "" && overflow !== "visible";
}

/**
 * The part of the scroll area where rows of `item` can be seen: Desktop's own lists clip their
 * content while they change height, and leaving rows are clipped the same way.
 */
function visibleArea(item: HTMLElement, viewport: HTMLElement, bounds: DOMRect): DOMRect {
  const view = item.ownerDocument.defaultView;
  let left = bounds.left + viewport.clientLeft;
  let top = bounds.top + viewport.clientTop;
  let right = left + viewport.clientWidth;
  let bottom = top + viewport.clientHeight;
  for (
    let node = item.parentElement;
    view && node && node !== viewport;
    node = node.parentElement
  ) {
    const style = view.getComputedStyle(node);
    if (!clips(style.overflowX) && !clips(style.overflowY)) continue;
    const rect = node.getBoundingClientRect();
    left = Math.max(left, rect.left);
    top = Math.max(top, rect.top);
    right = Math.min(right, rect.right);
    bottom = Math.min(bottom, rect.bottom);
  }
  return new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
}

/** Stops all motion at its end state, as before a new toggle or when the tree is removed. */
export function cancelSidebarThreadTreeMotion(): void {
  for (const animation of movements.values()) {
    animation.onfinish = null;
    animation.cancel();
  }
  movements.clear();
  for (const overlay of exits) overlay.remove();
  exits.clear();
}

/** Animates from the positions `motion` recorded to the layout the toggle produced. */
export function playSidebarThreadTreeMotion(
  motion: SidebarThreadTreeMotion,
  mountOverlay?: (overlay: HTMLElement, viewport: HTMLElement) => void,
): void {
  const { item, viewport, rows, blocks } = motion;
  // Moving rows were recorded where they appeared, so new motion starts from there.
  cancelSidebarThreadTreeMotion();
  if (!viewport.isConnected) return;
  const bounds = viewport.getBoundingClientRect();

  const present = new Set<string>();
  if (item.isConnected) {
    for (const element of item.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
      const key = element.getAttribute(ROW_KEY_ATTRIBUTE);
      if (!key) continue;
      present.add(key);
      const rect = element.getBoundingClientRect();
      const before = rows.get(key);
      if (!intersects(rect, bounds) && (!before || !intersects(before.rect, bounds))) continue;
      if (before) glide(element, before.rect, rect);
      else if (!rows.has(ownerRowKey(key) ?? ""))
        move(element, [{ opacity: 0 }, { opacity: 1 }], ROW_FADE_MS);
    }
  }
  for (const [element, before] of blocks) {
    if (!element.isConnected) continue;
    const rect = element.getBoundingClientRect();
    if (intersects(rect, bounds) || intersects(before, bounds)) glide(element, before, rect);
  }

  const leaving = [...rows].filter(
    ([key, row]) => !present.has(key) && row.clone !== null && !present.has(ownerRowKey(key) ?? ""),
  );
  if (leaving.length === 0) return;
  const area = visibleArea(item.isConnected ? item : viewport, viewport, bounds);
  const ownerDocument = viewport.ownerDocument;
  const overlay = ownerDocument.createElement("div");
  overlay.setAttribute(SIDEBAR_TREE_MOTION_ATTRIBUTE, "");
  overlay.setAttribute("aria-hidden", "true");
  overlay.inert = true;
  Object.assign(overlay.style, {
    position: "absolute",
    left: "0px",
    top: "0px",
    width: `${String(area.width)}px`,
    height: `${String(area.height)}px`,
    overflow: "clip",
    pointerEvents: "none",
    zIndex: "2",
    contain: "strict",
  });
  if (mountOverlay) mountOverlay(overlay, viewport);
  else viewport.append(overlay);
  // Place the overlay over the visible area, wherever its containing block puts it.
  const placed = overlay.getBoundingClientRect();
  const left = area.left - placed.left;
  const top = area.top - placed.top;
  overlay.style.left = `${String(left)}px`;
  overlay.style.top = `${String(top)}px`;
  const originLeft = area.left;
  const originTop = area.top;
  exits.add(overlay);
  let remaining = leaving.length;
  for (const [, row] of leaving) {
    const clone = row.clone as HTMLElement;
    Object.assign(clone.style, {
      position: "absolute",
      margin: "0",
      transform: "none",
      boxSizing: "border-box",
      left: `${String(row.rect.left - originLeft)}px`,
      top: `${String(row.rect.top - originTop)}px`,
      width: `${String(row.rect.width)}px`,
      height: `${String(row.rect.height)}px`,
    });
    overlay.append(clone);
    const animation = clone.animate([{ opacity: clone.style.opacity || "1" }, { opacity: 0 }], {
      duration: ROW_FADE_MS,
      easing: "ease-out",
      fill: "forwards",
    });
    animation.onfinish = () => {
      remaining -= 1;
      if (remaining > 0) return;
      overlay.remove();
      exits.delete(overlay);
    };
  }
}
