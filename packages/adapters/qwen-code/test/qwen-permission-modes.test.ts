import { harnessPermissionModeIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  QWEN_CODE_DEFAULT_PERMISSION_MODE_ID,
  QWEN_CODE_PERMISSION_MODE_CATALOG,
  currentQwenCodePermissionModeId,
  decodeQwenCodePermissionModeId,
} from "../src/index.js";

describe("Qwen Code Permission Modes", () => {
  it("matches the native Qwen Code SDK permission modes", () => {
    expect(QWEN_CODE_PERMISSION_MODE_CATALOG).toEqual({
      modes: [
        {
          id: "plan",
          label: "Plan",
          description: "Analyze only, do not modify files or execute commands.",
        },
        {
          id: "default",
          label: "Default",
          description: "Require approval for file edits or shell commands.",
        },
        {
          id: "auto-edit",
          label: "Auto Edit",
          description: "Automatically approve file edits.",
        },
        {
          id: "auto",
          label: "Auto",
          description: "LLM classifier auto-approves safe actions, blocks risky ones.",
        },
        {
          id: "yolo",
          label: "YOLO",
          description: "Automatically approve all tools.",
          dangerous: true,
        },
      ],
      defaultModeId: "default",
    });
  });

  it.each(["plan", "default", "auto-edit", "auto", "yolo"] as const)(
    "decodes native mode %s",
    (mode) => {
      const permissionModeId = harnessPermissionModeIdSchema.parse(mode);
      expect(decodeQwenCodePermissionModeId(permissionModeId)).toBe(mode);
    },
  );

  it("rejects Permission Modes owned by other Adapters", () => {
    expect(() =>
      decodeQwenCodePermissionModeId(harnessPermissionModeIdSchema.parse("always-approve")),
    ).toThrow();
  });

  it("keeps the safe mode as the create default", () => {
    expect(QWEN_CODE_DEFAULT_PERMISSION_MODE_ID).toBe("default");
  });

  it.each([
    ["yolo", "yolo"],
    ["plan", "plan"],
    ["grok", undefined],
    [42, undefined],
    [undefined, undefined],
  ] as const)("classifies native session mode %s", (value, expected) => {
    expect(currentQwenCodePermissionModeId(value as unknown)).toBe(expected);
  });
});
