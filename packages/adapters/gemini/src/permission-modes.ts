import {
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
  type HarnessPermissionModeCatalog,
  type HarnessPermissionModeId,
} from "@codexhost/shared-contracts";

export type GeminiPermissionMode = "default" | "auto_edit" | "yolo";

const nativePermissionModes = new Set<GeminiPermissionMode>(["default", "auto_edit", "yolo"]);

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
  const mapped: Record<string, GeminiPermissionMode> = {
    default: "default",
    ask: "default",
    auto: "auto_edit",
    "always-approve": "yolo",
  };
  const native = mapped[parsed];
  if (!native || !nativePermissionModes.has(native))
    throw new Error("Gemini Permission Mode belongs to another Adapter");
  return native;
}

export function geminiPermissionModeSessionMeta(permissionMode: GeminiPermissionMode): {
  yoloMode: boolean;
  autoMode: boolean;
} {
  return {
    yoloMode: permissionMode === "yolo",
    autoMode: permissionMode === "auto_edit",
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

/** Extract a previously selected mode when Gemini includes it in load metadata. */
export function permissionModeFromNativeResponse(
  value: unknown,
): HarnessPermissionModeId | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const metadata =
    typeof record._meta === "object" && record._meta !== null && !Array.isArray(record._meta)
      ? (record._meta as Record<string, unknown>)
      : record;
  const modes =
    typeof metadata.modes === "object" && metadata.modes !== null && !Array.isArray(metadata.modes)
      ? (metadata.modes as Record<string, unknown>)
      : metadata;
  const candidate = modes.currentModeId ?? metadata.permissionMode ?? metadata.permission_mode;
  if (candidate === "default") return harnessPermissionModeIdSchema.parse("default");
  if (candidate === "auto_edit") return harnessPermissionModeIdSchema.parse("auto");
  if (candidate === "yolo") return harnessPermissionModeIdSchema.parse("always-approve");
  if (candidate === "ask" || candidate === "auto" || candidate === "always-approve") {
    return harnessPermissionModeIdSchema.parse(candidate);
  }
  return undefined;
}
