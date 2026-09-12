import {
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
  type HarnessPermissionModeCatalog,
  type HarnessPermissionModeId,
} from "@codexhost/shared-contracts";

export type AntigravityPermissionMode = "dangerously-skip-permissions";

export const ANTIGRAVITY_DEFAULT_PERMISSION_MODE_ID = harnessPermissionModeIdSchema.parse(
  "dangerously-skip-permissions",
);

export const ANTIGRAVITY_PERMISSION_MODE_CATALOG: HarnessPermissionModeCatalog =
  harnessPermissionModeCatalogSchema.parse({
    modes: [
      {
        id: "dangerously-skip-permissions",
        label: "Skip permissions",
        description:
          "Run Antigravity CLI with --dangerously-skip-permissions. codexhost adds no tool approval or workspace restrictions.",
        dangerous: true,
      },
    ],
    defaultModeId: ANTIGRAVITY_DEFAULT_PERMISSION_MODE_ID,
  });

export function decodeAntigravityPermissionModeId(
  value: HarnessPermissionModeId,
): AntigravityPermissionMode {
  const parsed = harnessPermissionModeIdSchema.parse(value);
  if (parsed !== "dangerously-skip-permissions") {
    throw new Error(
      "Antigravity only supports Skip permissions (dangerous). Explicitly select Skip permissions to continue; codexhost does not enforce tool permissions.",
    );
  }
  return "dangerously-skip-permissions";
}
