import { describe, expect, it } from "vitest";

import {
  FLYOUT_TRAVEL_IDLE_MS,
  FLYOUT_TRAVEL_MAX_MS,
  createFlyoutTravelTracker,
  flyoutTravelArea,
  pointInPolygon,
  pointInRect,
  type FlyoutGeometry,
  type PointerZone,
} from "../src/renderer-flyout-pointer-travel.js";

// The Work model picker: the speed button (trigger) sits at the menu's inline start, the
// Model row spans the middle, and the flyout opens past the menu's inline end.
const rightFlyout: FlyoutGeometry = {
  trigger: { left: 10, right: 42, top: 20, bottom: 52 },
  flyout: { left: 330, right: 563, top: 10, bottom: 130 },
  side: "right",
};

const leftFlyout: FlyoutGeometry = {
  trigger: { left: 520, right: 552, top: 20, bottom: 52 },
  flyout: { left: 0, right: 233, top: 10, bottom: 130 },
  side: "left",
};

function at(x: number, y: number, time: number, zone: PointerZone = "outside") {
  return { point: { x, y }, time, zone };
}

describe("flyout pointer travel geometry", () => {
  it("tests rectangle and polygon membership", () => {
    expect(pointInRect({ x: 5, y: 5 }, { left: 0, right: 10, top: 0, bottom: 10 })).toBe(true);
    expect(pointInRect({ x: 11, y: 5 }, { left: 0, right: 10, top: 0, bottom: 10 })).toBe(false);
    const square = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(pointInPolygon({ x: 5, y: 5 }, square)).toBe(true);
    expect(pointInPolygon({ x: 15, y: 5 }, square)).toBe(false);
  });

  it("builds a corridor from the exit point to the flyout's near edge", () => {
    const area = flyoutTravelArea({ x: 42, y: 36 }, rightFlyout.flyout, "right");
    expect(pointInPolygon({ x: 200, y: 36 }, area)).toBe(true);
    expect(pointInPolygon({ x: 450, y: 100 }, area)).toBe(true);
    expect(pointInPolygon({ x: 200, y: 400 }, area)).toBe(false);
  });
});

describe("flyout travel tracker", () => {
  it("keeps travelling while a slow pointer crosses the rows between button and flyout", () => {
    const tracker = createFlyoutTravelTracker({ armed: false });
    expect(tracker.move(rightFlyout, at(30, 36, 0, "trigger"))).toBe(false);
    // Slower than Radix's 300 ms grace window: 1.2 s from the button to the flyout edge.
    for (let step = 1; step <= 12; step += 1) {
      expect(tracker.move(rightFlyout, at(42 + step * 24, 36, step * 100))).toBe(true);
    }
    // Arriving hands the pointer over; the flyout is a normal surface again.
    expect(tracker.move(rightFlyout, at(345, 36, 1300, "flyout"))).toBe(false);
    expect(tracker.move(rightFlyout, at(200, 36, 1400))).toBe(false);
  });

  it("is armed up front when a hover or click already put the pointer on the button", () => {
    const tracker = createFlyoutTravelTracker({ armed: true });
    expect(tracker.move(rightFlyout, at(80, 36, 0))).toBe(true);
  });

  it("does nothing when the pointer never came from the button", () => {
    const tracker = createFlyoutTravelTracker({ armed: false });
    expect(tracker.move(rightFlyout, at(150, 36, 0))).toBe(false);
    expect(tracker.move(rightFlyout, at(160, 36, 50))).toBe(false);
  });

  it("stops when the pointer heads back or away from the flyout", () => {
    const tracker = createFlyoutTravelTracker({ armed: true });
    expect(tracker.move(rightFlyout, at(60, 36, 50))).toBe(true);
    // Jitter within the tolerance is still "toward the flyout".
    expect(tracker.move(rightFlyout, at(58, 36, 100))).toBe(true);
    expect(tracker.move(rightFlyout, at(30, 60, 150))).toBe(false);
    // Once released it stays released until the pointer is back on the button.
    expect(tracker.move(rightFlyout, at(80, 36, 200))).toBe(false);
    expect(tracker.move(rightFlyout, at(30, 36, 250, "trigger"))).toBe(false);
    expect(tracker.move(rightFlyout, at(80, 36, 300))).toBe(true);
  });

  it("stops when the pointer leaves the corridor", () => {
    const tracker = createFlyoutTravelTracker({ armed: true });
    expect(tracker.move(rightFlyout, at(60, 36, 50))).toBe(true);
    expect(tracker.move(rightFlyout, at(100, 400, 100))).toBe(false);
  });

  it("stops after the pointer has rested too long", () => {
    const tracker = createFlyoutTravelTracker({ armed: true });
    expect(tracker.move(rightFlyout, at(80, 36, 100))).toBe(true);
    expect(tracker.move(rightFlyout, at(90, 36, 100 + FLYOUT_TRAVEL_IDLE_MS + 1))).toBe(false);
  });

  it("gives up on a trip that takes unreasonably long", () => {
    const tracker = createFlyoutTravelTracker({ armed: true });
    let time = 0;
    let travelling = true;
    for (let x = 50; x < 320 && travelling; x += 1) {
      time += 100;
      travelling = tracker.move(rightFlyout, at(x, 36, time));
    }
    expect(travelling).toBe(false);
    expect(time).toBeGreaterThan(FLYOUT_TRAVEL_MAX_MS);
  });

  it("mirrors the behaviour for a flyout opening to the left", () => {
    const tracker = createFlyoutTravelTracker({ armed: true });
    expect(tracker.move(leftFlyout, at(480, 36, 100))).toBe(true);
    expect(tracker.move(leftFlyout, at(400, 36, 200))).toBe(true);
    expect(tracker.move(leftFlyout, at(395, 36, 250))).toBe(true);
    // Turning back toward the button ends the trip.
    expect(tracker.move(leftFlyout, at(430, 36, 300))).toBe(false);
  });

  it("lets a pointer that is simply on the button or the flyout through", () => {
    const tracker = createFlyoutTravelTracker({ armed: false });
    expect(tracker.move(rightFlyout, at(30, 36, 0, "trigger"))).toBe(false);
    expect(tracker.move(rightFlyout, at(400, 60, 10, "flyout"))).toBe(false);
  });
});
