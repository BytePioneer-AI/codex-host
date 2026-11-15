import {
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
  type HarnessPermissionModeCatalog,
  type HarnessPermissionModeId,
} from "@codexhost/shared-contracts";

export const ANTIGRAVITY_ACP_SESSION_MODES = ["default", "accept-edits", "auto", "plan"] as const;

export type AntigravityAcpSessionMode = (typeof ANTIGRAVITY_ACP_SESSION_MODES)[number];

export type AntigravityPermissionMode = AntigravityAcpSessionMode | "dangerously-skip-permissions";

export const ANTIGRAVITY_DEFAULT_PERMISSION_MODE_ID =
  harnessPermissionModeIdSchema.parse("default");

export const ANTIGRAVITY_PERMISSION_MODE_CATALOG: HarnessPermissionModeCatalog =
  harnessPermissionModeCatalogSchema.parse({
    modes: [
      {
        id: "default",
        label: "Default",
        localizations: {
          en: {
            label: "Default",
            description: "Ask before edits and commands, per your permission settings.",
          },
          "zh-CN": {
            label: "默认询问",
            description: "按权限设置在修改文件或执行命令前请求确认。",
          },
        },
        description: "Ask before edits and commands, per your permission settings.",
      },
      {
        id: "accept-edits",
        label: "Accept edits",
        localizations: {
          en: {
            label: "Accept edits",
            description: "Approve file edits in the workspace without asking.",
          },
          "zh-CN": {
            label: "自动接受编辑",
            description: "自动批准工作区内的文件修改。",
          },
        },
        description: "Approve file edits in the workspace without asking.",
      },
      {
        id: "auto",
        label: "Auto",
        localizations: {
          en: {
            label: "Auto",
            description: "Approve edits and safe commands; ask before irreversible actions.",
          },
          "zh-CN": {
            label: "自动模式",
            description: "自动批准文件修改与安全命令，不可逆操作前请求确认。",
          },
        },
        description: "Approve edits and safe commands; ask before irreversible actions.",
      },
      {
        id: "plan",
        label: "Plan",
        localizations: {
          en: {
            label: "Plan",
            description: "Plan carefully before executing a task.",
          },
          "zh-CN": {
            label: "计划模式",
            description: "执行任务前先进行规划。",
          },
        },
        description: "Plan carefully before executing a task.",
      },
      {
        id: "dangerously-skip-permissions",
        label: "Skip permissions",
        localizations: {
          en: {
            label: "Skip permissions",
            description:
              "Run Antigravity ACP with --dangerously-skip-permissions to auto-approve all tool permission requests.",
          },
          "zh-CN": {
            label: "跳过权限检查",
            description:
              "使用 --dangerously-skip-permissions 启动 Antigravity ACP，自动批准所有工具权限请求。",
          },
        },
        description:
          "Run Antigravity ACP with --dangerously-skip-permissions to auto-approve all tool permission requests.",
        dangerous: true,
      },
    ],
    defaultModeId: ANTIGRAVITY_DEFAULT_PERMISSION_MODE_ID,
  });

export function isAntigravityAcpSessionMode(value: unknown): value is AntigravityAcpSessionMode {
  return (
    typeof value === "string" &&
    (ANTIGRAVITY_ACP_SESSION_MODES as readonly string[]).includes(value)
  );
}

export function decodeAntigravityPermissionModeId(
  value: HarnessPermissionModeId,
): AntigravityPermissionMode {
  const parsed: string = harnessPermissionModeIdSchema.parse(value);
  if (parsed === "dangerously-skip-permissions") {
    return "dangerously-skip-permissions";
  }
  if (isAntigravityAcpSessionMode(parsed)) {
    return parsed;
  }
  throw new Error(`Unsupported Antigravity permission mode '${parsed}'`);
}
