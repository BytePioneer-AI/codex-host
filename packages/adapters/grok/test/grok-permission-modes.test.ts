import { harnessPermissionModeIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  GROK_PERMISSION_MODE_CATALOG,
  decodeGrokPermissionModeId,
  grokPermissionModeSessionMeta,
} from "../src/index.js";

describe("Grok Permission Modes", () => {
  it("matches the native Grok Build Permission Mode picker", () => {
    expect(GROK_PERMISSION_MODE_CATALOG).toEqual({
      modes: [
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
      defaultModeId: "ask",
    });
  });

  it.each([
    ["ask", { yoloMode: false, autoMode: false }],
    ["auto", { yoloMode: false, autoMode: true }],
    ["always-approve", { yoloMode: true, autoMode: false }],
  ] as const)("maps %s to native create metadata", (mode, expected) => {
    const permissionModeId = harnessPermissionModeIdSchema.parse(mode);
    expect(grokPermissionModeSessionMeta(decodeGrokPermissionModeId(permissionModeId))).toEqual(
      expected,
    );
  });
});
