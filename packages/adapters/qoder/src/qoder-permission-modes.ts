import {
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
  type HarnessPermissionModeCatalog,
  type HarnessPermissionModeId,
} from "@codexhost/shared-contracts";

import type { QoderPermissionMode } from "./qoder-sdk-types.js";

export const QODER_DEFAULT_PERMISSION_MODE_ID: HarnessPermissionModeId =
  harnessPermissionModeIdSchema.parse("default");

export const QODER_PERMISSION_MODE_CATALOG: HarnessPermissionModeCatalog =
  harnessPermissionModeCatalogSchema.parse({
    modes: [
      {
        id: "default",
        label: "Default",
        localizations: { "zh-CN": { label: "默认", description: "执行受保护的工具操作前询问。" } },
        description: "Ask before protected tool actions.",
      },
      {
        id: "acceptEdits",
        label: "Accept Edits",
        localizations: { "zh-CN": { label: "接受编辑", description: "自动接受文件变更。" } },
        description: "Automatically accept file changes.",
      },
      {
        id: "auto",
        label: "Auto",
        localizations: { "zh-CN": { label: "自动", description: "自动允许安全的工具操作。" } },
        description: "Automatically allow safe tool actions.",
      },
      {
        id: "plan",
        label: "Plan",
        localizations: {
          "zh-CN": { label: "规划模式", description: "仅执行只读操作的规划模式。" },
        },
        description: "Plan mode with read-only operations.",
      },
      {
        id: "bypassPermissions",
        label: "Bypass Permissions",
        localizations: {
          "zh-CN": { label: "绕过权限", description: "无需提示即可批准所有工具操作。" },
        },
        description: "Approve all tool actions without prompting.",
        dangerous: true,
      },
    ],
    defaultModeId: QODER_DEFAULT_PERMISSION_MODE_ID,
  });

export function mapToQoderPermissionMode(
  id: HarnessPermissionModeId | undefined,
): QoderPermissionMode | undefined {
  if (!id) return undefined;
  const str = String(id);
  if (
    str === "default" ||
    str === "acceptEdits" ||
    str === "bypassPermissions" ||
    str === "yolo" ||
    str === "plan" ||
    str === "dontAsk" ||
    str === "auto"
  ) {
    return str as QoderPermissionMode;
  }
  return undefined;
}

/** Plan is a separate SDK control (`planMode` / `setPlanMode`), not `permissionMode: "plan"`. */
export function isQoderPlanModeId(id: HarnessPermissionModeId | undefined): boolean {
  return String(id ?? "") === "plan";
}

/** Map harness mode to SDK permissionMode, excluding plan (use planMode instead). */
export function mapToQoderPermissionModeExcludingPlan(
  id: HarnessPermissionModeId | undefined,
): QoderPermissionMode | undefined {
  if (isQoderPlanModeId(id)) return undefined;
  return mapToQoderPermissionMode(id);
}
