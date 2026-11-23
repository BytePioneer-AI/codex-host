import { harnessPermissionModeIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";
import {
  ANTIGRAVITY_ACP_SESSION_MODES,
  ANTIGRAVITY_PERMISSION_MODE_CATALOG,
  decodeAntigravityPermissionModeId,
  isAntigravityAcpSessionMode,
} from "../src/permission-modes.js";

describe("native ACP permission modes", () => {
  it.each(ANTIGRAVITY_ACP_SESSION_MODES)("round-trips native mode %s", (mode) => {
    expect(isAntigravityAcpSessionMode(mode)).toBe(true);
    expect(decodeAntigravityPermissionModeId(harnessPermissionModeIdSchema.parse(mode))).toBe(mode);
    expect(ANTIGRAVITY_PERMISSION_MODE_CATALOG.modes.find(({ id }) => id === mode)).toBeDefined();
  });
  it("keeps launch-time skip-permissions separate from native session modes", () => {
    const skip = "dangerously-skip-permissions";
    expect(isAntigravityAcpSessionMode(skip)).toBe(false);
    expect(decodeAntigravityPermissionModeId(harnessPermissionModeIdSchema.parse(skip))).toBe(skip);
    expect(ANTIGRAVITY_PERMISSION_MODE_CATALOG.modes.find(({ id }) => id === skip)?.dangerous).toBe(
      true,
    );
    expect(ANTIGRAVITY_PERMISSION_MODE_CATALOG.defaultModeId).toBe(skip);
  });
  it.each([null, undefined, 1, {}, "default ", "bypassPermissions", "all"])(
    "rejects non-native mode %j",
    (value) => expect(isAntigravityAcpSessionMode(value)).toBe(false),
  );
  it("rejects unknown but syntactically valid IDs", () =>
    expect(() =>
      decodeAntigravityPermissionModeId(harnessPermissionModeIdSchema.parse("unknown")),
    ).toThrow("Unsupported"));
});
