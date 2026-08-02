import {
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
} from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  isPermissionModeControlReady,
  rendererPermissionModeLabel,
} from "../src/renderer-permission-mode-picker.js";

const catalog = harnessPermissionModeCatalogSchema.parse({
  modes: [
    { id: "plan", label: "Plan mode", description: "Plan without execution." },
    { id: "default", label: "Default" },
    { id: "bypassPermissions", label: "Bypass permissions", dangerous: true },
  ],
  defaultModeId: "default",
});

describe("Renderer Permission Mode picker presentation", () => {
  it("is ready only for an Adapter-confirmed catalog entry", () => {
    const selected = harnessPermissionModeIdSchema.parse("default");
    expect(isPermissionModeControlReady({ status: "ready", catalog, selected })).toBe(true);
    expect(
      isPermissionModeControlReady({
        status: "ready",
        catalog,
        selected: harnessPermissionModeIdSchema.parse("future"),
      }),
    ).toBe(false);
    expect(isPermissionModeControlReady({ status: "selecting", catalog, selected })).toBe(false);
    expect(isPermissionModeControlReady({ status: "error", catalog, selected })).toBe(true);
    expect(isPermissionModeControlReady({ status: "error", error: "inspection failed" })).toBe(
      false,
    );
  });

  it("treats a structurally unsupported Harness as complete without inventing a mode", () => {
    expect(isPermissionModeControlReady({ status: "unsupported" })).toBe(true);
    expect(rendererPermissionModeLabel({ status: "unsupported" })).toBe("Permissions");
  });

  it("uses only Adapter-provided labels and stable pending/error labels", () => {
    expect(
      rendererPermissionModeLabel({
        status: "ready",
        catalog,
        selected: harnessPermissionModeIdSchema.parse("plan"),
      }),
    ).toBe("Plan mode");
    expect(rendererPermissionModeLabel({ status: "loading" })).toBe("Loading permissions...");
    expect(rendererPermissionModeLabel({ status: "error", error: "offline" })).toBe(
      "Permissions unavailable",
    );
  });
});
