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
        description: "Ask before protected tool actions.",
      },
      {
        id: "acceptEdits",
        label: "Accept Edits",
        description: "Automatically accept file changes.",
      },
      {
        id: "auto",
        label: "Auto",
        description: "Automatically allow safe tool actions.",
      },
      {
        id: "plan",
        label: "Plan",
        description: "Plan mode with read-only operations.",
      },
      {
        id: "bypassPermissions",
        label: "Bypass Permissions",
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
  return "default";
}
