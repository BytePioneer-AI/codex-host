import { describe, expect, it } from "vitest";

import { pngSize, renderIcon } from "../../scripts/release/macos/assets.mjs";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("macOS install artwork", () => {
  it("renders a valid 1024x1024 app icon master", () => {
    const png = renderIcon();
    expect(png.subarray(0, 8)).toEqual(PNG_SIGNATURE);
    expect(pngSize(png)).toEqual({ width: 1024, height: 1024 });
  });
});
