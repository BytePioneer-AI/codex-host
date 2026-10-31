import {
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
  type HarnessPermissionModeCatalog,
  type HarnessPermissionModeId,
} from "@codexhost/shared-contracts";

export type QwenCodePermissionMode = "plan" | "default" | "auto-edit" | "auto" | "yolo";

const nativePermissionModes = new Set<QwenCodePermissionMode>([
  "plan",
  "default",
  "auto-edit",
  "auto",
  "yolo",
]);

export const QWEN_CODE_DEFAULT_PERMISSION_MODE_ID = harnessPermissionModeIdSchema.parse("default");

export const QWEN_CODE_PERMISSION_MODE_CATALOG: HarnessPermissionModeCatalog =
  harnessPermissionModeCatalogSchema.parse({
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
    defaultModeId: QWEN_CODE_DEFAULT_PERMISSION_MODE_ID,
  });

export function decodeQwenCodePermissionModeId(
  permissionModeId: HarnessPermissionModeId,
): QwenCodePermissionMode {
  const parsed = harnessPermissionModeIdSchema.parse(permissionModeId);
  if (!nativePermissionModes.has(parsed as QwenCodePermissionMode)) {
    throw new Error("Qwen Code Permission Mode belongs to another Adapter");
  }
  return parsed as QwenCodePermissionMode;
}

export function currentQwenCodePermissionModeId(
  value: unknown,
): HarnessPermissionModeId | undefined {
  if (typeof value !== "string") return undefined;
  if (!nativePermissionModes.has(value as QwenCodePermissionMode)) return undefined;
  return harnessPermissionModeIdSchema.parse(value);
}
