import { harnessPermissionModeIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  GROK_PERMISSION_MODE_CATALOG,
  decodeGrokPermissionModeId,
  grokPermissionModeNotification,
  grokPermissionModeSessionMeta,
} from "../src/index.js";

describe("Grok Permission Modes", () => {
  it("matches the native Grok Build Permission Mode picker", () => {
    expect(GROK_PERMISSION_MODE_CATALOG).toEqual({
      modes: [
        {
          id: "default",
          label: "Default",
          description: "Use Grok Build's default interactive approval policy.",
        },
        {
          id: "ask",
          label: "Ask",
          description: "Ask before protected tool actions.",
        },
        {
          id: "auto",
          label: "Auto",
          description: "Let Grok Build decide which tool actions may run automatically.",
        },
        {
          id: "always-approve",
          label: "Always approve",
          description: "Approve all tool actions without prompting.",
          dangerous: true,
        },
      ],
      defaultModeId: "default",
    });
  });

  it.each([
    ["default", { yoloMode: false, autoMode: false }],
    ["ask", { yoloMode: false, autoMode: false }],
    ["auto", { yoloMode: false, autoMode: true }],
    ["always-approve", { yoloMode: true, autoMode: false }],
  ] as const)("maps %s to native create metadata", (mode, expected) => {
    const permissionModeId = harnessPermissionModeIdSchema.parse(mode);
    expect(grokPermissionModeSessionMeta(decodeGrokPermissionModeId(permissionModeId))).toEqual(
      expected,
    );
  });

  it("maps Auto to the native runtime notification", () => {
    expect(grokPermissionModeNotification("auto")).toEqual({
      yolo_mode: false,
      auto_mode: true,
      permission_mode: "auto",
    });
  });
});
