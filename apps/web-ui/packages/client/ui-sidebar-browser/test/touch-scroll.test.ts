import { expect, it } from "vitest";
import { TouchScroll } from "../src/client/remote/TouchScroll.ts";

it("keeps the touch-down target while sending each move's incremental delta", () => {
  const swipe = new TouchScroll(1, { x: 40, y: 120 }, 140, 220);
  expect(swipe.move(141, 218)).toBeUndefined();
  expect(swipe.tapped).toBe(true);
  expect(swipe.move(145, 207)).toEqual({ type: "wheel", x: 40, y: 120, deltaX: -4, deltaY: 11 });
  expect(swipe.move(142, 183)).toEqual({ type: "wheel", x: 40, y: 120, deltaX: 3, deltaY: 24 });
  expect(swipe.tapped).toBe(false);
});
