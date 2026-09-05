import {
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
  type HarnessPermissionModeCatalog,
  type HarnessPermissionModeId,
} from "@codexhost/shared-contracts";

export type AntigravityPermissionMode =
  "configured" | "desktop-approvals" | "dangerously-skip-permissions";

export const ANTIGRAVITY_DEFAULT_PERMISSION_MODE_ID =
  harnessPermissionModeIdSchema.parse("configured");

export const ANTIGRAVITY_PERMISSION_MODE_CATALOG: HarnessPermissionModeCatalog =
  harnessPermissionModeCatalogSchema.parse({
    modes: [
      {
        id: "configured",
        label: "Configured permissions",
        description: "Use Antigravity CLI permission rules; headless prompts are denied safely.",
      },
      {
        id: "desktop-approvals",
        label: "Desktop approvals",
        description:
          "Ask Desktop before each parent tool action. Uses native auto-execution behind a verified, fail-closed Hook; does not use configured permission prompts.",
      },
      {
        id: "dangerously-skip-permissions",
        label: "Skip permissions",
        description: "Auto-approve every Antigravity CLI tool action.",
        dangerous: true,
      },
    ],
    defaultModeId: ANTIGRAVITY_DEFAULT_PERMISSION_MODE_ID,
  });

export function decodeAntigravityPermissionModeId(
  value: HarnessPermissionModeId,
): AntigravityPermissionMode {
  const parsed = harnessPermissionModeIdSchema.parse(value);
  if (
    parsed !== "configured" &&
    parsed !== "desktop-approvals" &&
    parsed !== "dangerously-skip-permissions"
  ) {
    throw new Error("Antigravity Permission Mode belongs to another Adapter");
  }
  return parsed as AntigravityPermissionMode;
}
