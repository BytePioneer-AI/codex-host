/**
 * Decides whether the pointer is on its way from a flyout's trigger to the
 * flyout itself, so the rows it crosses on the way cannot dismiss the flyout.
 *
 * A flyout that opens beside a wide menu is not adjacent to its trigger: the
 * straight path to it runs over sibling rows (the official Model row sits
 * between the speed button and its flyout). Those rows take focus as soon as
 * the pointer touches them, and a flyout that closes on any outside focus is
 * gone before the pointer arrives. This is the same grace corridor the official
 * Radix submenu keeps, without its 300 ms limit: the pointer may be slow, but it
 * has to keep heading for the flyout.
 *
 * Pure geometry and timing, no DOM access, so it can be tested directly.
 */

export type FlyoutSide = "left" | "right";
export type PointerZone = "trigger" | "flyout" | "outside";

export interface PointerPoint {
  x: number;
  y: number;
}

export interface RectLike {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface FlyoutGeometry {
  trigger: RectLike;
  flyout: RectLike;
  side: FlyoutSide;
}

export interface PointerMove {
  point: PointerPoint;
  /** Monotonic milliseconds. */
  time: number;
  zone: PointerZone;
}

/** Longest a single trip from the trigger to the flyout may keep rows inert. */
export const FLYOUT_TRAVEL_MAX_MS = 2000;
/** A pointer that stops for this long is no longer considered to be travelling. */
export const FLYOUT_TRAVEL_IDLE_MS = 350;
const BACKTRACK_TOLERANCE_PX = 3;
const EXIT_PADDING_PX = 5;
const VERTICAL_SLOP_PX = 8;

export function pointInRect(point: PointerPoint, rect: RectLike): boolean {
  return (
    point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom
  );
}

export function pointInPolygon(point: PointerPoint, polygon: readonly PointerPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (!a || !b) continue;
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/** The corridor from the exit point to the flyout's near edge. */
export function flyoutTravelArea(
  exit: PointerPoint,
  flyout: RectLike,
  side: FlyoutSide,
): PointerPoint[] {
  const toRight = side === "right";
  const near = toRight ? flyout.left : flyout.right;
  const far = toRight ? flyout.right : flyout.left;
  const top = flyout.top - VERTICAL_SLOP_PX;
  const bottom = flyout.bottom + VERTICAL_SLOP_PX;
  return [
    { x: exit.x + (toRight ? -EXIT_PADDING_PX : EXIT_PADDING_PX), y: exit.y },
    { x: near, y: top },
    { x: far, y: top },
    { x: far, y: bottom },
    { x: near, y: bottom },
  ];
}

interface Transit {
  exit: PointerPoint;
  startedAt: number;
  lastMoveAt: number;
  lastX: number;
}

export interface FlyoutTravelTracker {
  /** Feed one pointer move; true while the pointer is still travelling to the flyout. */
  move(geometry: FlyoutGeometry, move: PointerMove): boolean;
}

/**
 * `armed` says the pointer is known to be on the trigger now (a hover or a click
 * opened the flyout); otherwise it has to be seen there first, so a keyboard
 * open with the pointer elsewhere never suppresses anything.
 */
export function createFlyoutTravelTracker(options: { armed: boolean }): FlyoutTravelTracker {
  let armed = options.armed;
  let transit: Transit | null = null;

  const stillTravelling = (geometry: FlyoutGeometry, current: Transit, move: PointerMove) => {
    if (move.time - current.startedAt > FLYOUT_TRAVEL_MAX_MS) return false;
    if (move.time - current.lastMoveAt > FLYOUT_TRAVEL_IDLE_MS) return false;
    const dx = move.point.x - current.lastX;
    const away = geometry.side === "right" ? -dx : dx;
    if (away > BACKTRACK_TOLERANCE_PX) return false;
    current.lastMoveAt = move.time;
    current.lastX = move.point.x;
    return pointInPolygon(
      move.point,
      flyoutTravelArea(current.exit, geometry.flyout, geometry.side),
    );
  };

  return {
    move(geometry, move) {
      if (move.zone === "trigger") {
        armed = true;
        transit = null;
        return false;
      }
      if (move.zone === "flyout") {
        armed = false;
        transit = null;
        return false;
      }
      if (transit === null) {
        if (!armed) return false;
        transit = {
          exit: move.point,
          startedAt: move.time,
          lastMoveAt: move.time,
          lastX: move.point.x,
        };
        armed = false;
      }
      if (!stillTravelling(geometry, transit, move)) {
        transit = null;
        return false;
      }
      return true;
    },
  };
}
