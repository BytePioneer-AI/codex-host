import {
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
  type HarnessPermissionModeCatalog,
  type HarnessPermissionModeId,
} from "@codexhost/shared-contracts";

export type GeminiPermissionMode = "default" | "ask" | "auto" | "always-approve";

const nativePermissionModes = new Set<GeminiPermissionMode>([
  "default",
  "ask",
  "auto",
  "always-approve",
]);

export const GEMINI_DEFAULT_PERMISSION_MODE_ID = harnessPermissionModeIdSchema.parse("default");

export const GEMINI_PERMISSION_MODE_CATALOG: HarnessPermissionModeCatalog =
  harnessPermissionModeCatalogSchema.parse({
    modes: [
      {
        id: "default",
        label: "Default",
        description: "Use Gemini Build's default interactive approval policy.",
      },
      {
        id: "ask",
        label: "Ask",
        description: "Ask before protected tool actions.",
      },
      {
        id: "auto",
        label: "Auto",
        description: "Let Gemini Build decide which tool actions may run automatically.",
      },
      {
        id: "always-approve",
        label: "Always approve",
        description: "Approve all tool actions without prompting.",
        dangerous: true,
      },
    ],
    defaultModeId: GEMINI_DEFAULT_PERMISSION_MODE_ID,
  });

export function decodeGeminiPermissionModeId(
  permissionModeId: HarnessPermissionModeId,
): GeminiPermissionMode {
  const parsed = harnessPermissionModeIdSchema.parse(permissionModeId);
  if (!nativePermissionModes.has(parsed as GeminiPermissionMode)) {
    throw new Error("Gemini Permission Mode belongs to another Adapter");
  }
  return parsed as GeminiPermissionMode;
}

export function geminiPermissionModeSessionMeta(permissionMode: GeminiPermissionMode): {
  yoloMode: boolean;
  autoMode: boolean;
} {
  return {
    yoloMode: permissionMode === "always-approve",
    autoMode: permissionMode === "auto",
  };
}

export function geminiPermissionModeNotification(permissionMode: GeminiPermissionMode): {
  yolo_mode: boolean;
  auto_mode: boolean;
  permission_mode: GeminiPermissionMode;
} {
  const state = geminiPermissionModeSessionMeta(permissionMode);
  return {
    yolo_mode: state.yoloMode,
    auto_mode: state.autoMode,
    permission_mode: permissionMode,
  };
}
