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
        localizations: {
          "zh-CN": {
            label: "跳过权限检查",
            description:
              "使用 --dangerously-skip-permissions 运行 Antigravity CLI；codexhost 不增加工具审批或工作区限制。",
          },
        },
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
