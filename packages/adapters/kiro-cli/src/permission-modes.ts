import type {
  HarnessPermissionMode,
  HarnessPermissionModeCatalog,
  HarnessPermissionModeId,
} from "@codexhost/shared-contracts";
import { harnessPermissionModeIdSchema } from "@codexhost/shared-contracts";

export const KIRO_DEFAULT_PERMISSION_MODE_ID = harnessPermissionModeIdSchema.parse("autopilot");

export const KIRO_PERMISSION_MODES: HarnessPermissionMode[] = [
  {
    id: KIRO_DEFAULT_PERMISSION_MODE_ID,
    label: "Autopilot",
    localizations: {
      "zh-CN": { label: "自动执行", description: "在原生策略范围内自动执行工具。" },
    },
    description: "Automatic tool execution within native policy bounds",
  },
  {
    id: harnessPermissionModeIdSchema.parse("supervised"),
    label: "Supervised",
    localizations: { "zh-CN": { label: "人工监督", description: "人工审核工具审批与文件修改。" } },
    description: "Manual review of tool approvals and file modifications",
  },
];

export const KIRO_PERMISSION_MODE_CATALOG: HarnessPermissionModeCatalog = {
  modes: KIRO_PERMISSION_MODES,
  defaultModeId: KIRO_DEFAULT_PERMISSION_MODE_ID,
};

export function decodeKiroPermissionMode(modeId: HarnessPermissionModeId): "on" | "off" {
  return modeId === "supervised" ? "off" : "on";
}

export function encodeKiroPermissionMode(nativeValue: unknown): HarnessPermissionModeId {
  if (nativeValue === "off" || nativeValue === false) {
    return harnessPermissionModeIdSchema.parse("supervised");
  }
  return KIRO_DEFAULT_PERMISSION_MODE_ID;
}
