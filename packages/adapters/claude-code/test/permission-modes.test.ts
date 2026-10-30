import { describe, expect, it } from "vitest";

import {
  claudeBypassPermissionsAvailable,
  claudePermissionModeCatalogForModels,
} from "../src/permission-modes.js";

const root = { getuid: () => 0 };
const user = { getuid: () => 1000 };
const windows = {};

function modeIds(models: unknown, bypassPermissionsAvailable?: boolean): string[] {
  return claudePermissionModeCatalogForModels(models, bypassPermissionsAvailable).modes.map(
    ({ id }) => id,
  );
}

describe("Claude bypass permissions availability", () => {
  it("allows non-root users and platforms without getuid", () => {
    expect(claudeBypassPermissionsAvailable({}, user)).toBe(true);
    expect(claudeBypassPermissionsAvailable({}, windows)).toBe(true);
  });

  it("rejects root without a declared sandbox", () => {
    expect(claudeBypassPermissionsAvailable({}, root)).toBe(false);
    expect(claudeBypassPermissionsAvailable({ IS_SANDBOX: "" }, root)).toBe(false);
    expect(claudeBypassPermissionsAvailable({ CLAUDE_CODE_BUBBLEWRAP: "0" }, root)).toBe(false);
  });

  it("allows root when IS_SANDBOX is exactly 1, matching Claude Code", () => {
    expect(claudeBypassPermissionsAvailable({ IS_SANDBOX: "1" }, root)).toBe(true);
    expect(claudeBypassPermissionsAvailable({ IS_SANDBOX: "true" }, root)).toBe(false);
    expect(claudeBypassPermissionsAvailable({ IS_SANDBOX: " 1" }, root)).toBe(false);
  });

  it("allows root inside a declared bubblewrap sandbox", () => {
    for (const value of ["1", "true", "YES", " on "]) {
      expect(claudeBypassPermissionsAvailable({ CLAUDE_CODE_BUBBLEWRAP: value }, root)).toBe(true);
    }
  });
});

describe("Claude Permission Mode catalog", () => {
  const autoModel = [{ value: "sonnet", supportsAutoMode: true }];

  it("keeps bypass permissions by default", () => {
    expect(modeIds(autoModel)).toEqual([
      "plan",
      "default",
      "acceptEdits",
      "auto",
      "bypassPermissions",
    ]);
    expect(modeIds([])).toEqual(["plan", "default", "acceptEdits", "bypassPermissions"]);
  });

  it("omits bypass permissions when Claude Code cannot use it", () => {
    expect(modeIds(autoModel, false)).toEqual(["plan", "default", "acceptEdits", "auto"]);
    expect(modeIds([], false)).toEqual(["plan", "default", "acceptEdits"]);
    expect(claudePermissionModeCatalogForModels([], false).defaultModeId).toBe("default");
  });
});
