import { describe, expect, it } from "vitest";

import { iconDimensions, readIcon } from "../../scripts/release/macos/assets.mjs";

describe("macOS install artwork", () => {
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
});
