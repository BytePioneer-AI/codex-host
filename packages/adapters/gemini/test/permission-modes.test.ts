import { describe, expect, it } from "vitest";

import { permissionModeFromNativeResponse } from "../src/permission-modes.js";

describe("Gemini native permission metadata", () => {
  it("restores a mode from load-session metadata", () => {
    expect(permissionModeFromNativeResponse({ _meta: { permission_mode: "auto" } })).toBe("auto");
  });

  it("ignores unknown or malformed modes", () => {
    expect(permissionModeFromNativeResponse({ _meta: { modeId: "unknown" } })).toBeUndefined();
    expect(permissionModeFromNativeResponse(null)).toBeUndefined();
  });
});
