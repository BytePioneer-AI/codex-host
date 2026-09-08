import { describe, expect, it } from "vitest";
import { harnessPermissionModeIdSchema } from "@codexhost/shared-contracts";

import {
  MUSE_DEFAULT_PERMISSION_MODE_ID,
  MUSE_PERMISSION_MODE_CATALOG,
  decodeMusePermissionModeId,
  musePermissionModeForExecutionPolicy,
} from "../src/permission-modes.js";

describe("Muse permission catalog", () => {
  it("uses the native prompt-unmatched default for an unconfigured Session", () => {
    expect(MUSE_PERMISSION_MODE_CATALOG.defaultModeId).toBe("promptUnmatched");
    expect(MUSE_DEFAULT_PERMISSION_MODE_ID).toBe("promptUnmatched");
    expect(musePermissionModeForExecutionPolicy(undefined)).toBe("promptUnmatched");
    expect(musePermissionModeForExecutionPolicy("default")).toBe("promptUnmatched");
  });

  it("only advertises modes selectable under the native serve startup policy", () => {
    expect(MUSE_PERMISSION_MODE_CATALOG.modes.map((entry) => entry.id)).toEqual([
      "promptUnmatched",
      "denyUnmatched",
    ]);
  });

  it.each(["onRequest", "promptUnmatched", "denyUnmatched", "allowAll"])(
    "preserves the explicit %s selection for native policy enforcement",
    (mode) => {
      const permissionModeId = harnessPermissionModeIdSchema.parse(mode);
      expect(decodeMusePermissionModeId(permissionModeId)).toBe(mode);
      expect(musePermissionModeForExecutionPolicy("default", permissionModeId)).toBe(mode);
    },
  );

  it("does not silently downgrade unattended full access to a prompt mode", () => {
    expect(musePermissionModeForExecutionPolicy("unattended-full-access")).toBe("allowAll");
  });
});
