import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { iconDimensions, readIcon } from "../../scripts/release/macos/assets.mjs";

describe("native application artwork", () => {
  it("uses the multi-size launcher icon as its source", () => {
    expect(iconDimensions(readIcon())).toEqual([
      { width: 16, height: 16 },
      { width: 24, height: 24 },
      { width: 32, height: 32 },
      { width: 48, height: 48 },
      { width: 64, height: 64 },
      { width: 128, height: 128 },
      { width: 256, height: 256 },
    ]);
  });

  it("provides transparent PNG artwork at native and ICO frame resolutions", () => {
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const png = readFileSync(
      new URL("../../crates/launcher/assets/codexhost.png", import.meta.url),
    );
    const icon = readIcon();
    const frames = iconDimensions(icon).map(({ width, height }, index) => {
      const entry = 6 + index * 16;
      const length = icon.readUInt32LE(entry + 8);
      const offset = icon.readUInt32LE(entry + 12);
      expect(offset + length).toBeLessThanOrEqual(icon.length);
      return { image: icon.subarray(offset, offset + length), width, height };
    });
    for (const { image, width, height } of [{ image: png, width: 1024, height: 1024 }, ...frames]) {
      expect(image.subarray(0, 8)).toEqual(signature);
      expect(image.readUInt32BE(16)).toBe(width);
      expect(image.readUInt32BE(20)).toBe(height);
      expect(image[25]).toBe(6); // PNG RGBA color type.
    }
  });
});
