import { describe, expect, it } from "vitest";

import {
  type RendererSettingsBounds,
  selectRendererSettingsHeaderSlot,
} from "../../src/settings/trigger.js";

function bounds(left: number, top: number, width: number, height: number): RendererSettingsBounds {
  return {
    left,
    right: left + width,
    top,
    bottom: top + height,
    width,
    height,
  };
}

describe("Renderer settings header trigger", () => {
  const header = bounds(240, 36, 942, 46);

  it("selects the bounded native action slot at the right edge", () => {
    expect(
      selectRendererSettingsHeaderSlot(header, [
        { value: "context", bounds: bounds(248, 36, 864, 46), visibleButtonCount: 1 },
        { value: "hidden", bounds: bounds(0, 0, 70, 28), visibleButtonCount: 2 },
        { value: "actions", bounds: bounds(1112, 36, 70, 46), visibleButtonCount: 2 },
      ]),
    ).toBe("actions");
  });

  it("fails closed without a visible bounded right-side action slot", () => {
    expect(
      selectRendererSettingsHeaderSlot(header, [
        { value: "context", bounds: bounds(248, 36, 864, 46), visibleButtonCount: 2 },
        { value: "empty", bounds: bounds(1112, 36, 70, 46), visibleButtonCount: 0 },
        { value: "outside", bounds: bounds(1184, 36, 40, 46), visibleButtonCount: 1 },
      ]),
    ).toBeNull();
  });
});
