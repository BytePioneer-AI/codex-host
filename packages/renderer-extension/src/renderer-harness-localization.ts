import type { HarnessCommandDescriptor, HarnessPermissionMode } from "@codexhost/shared-contracts";

import type { RendererSettingsLocale } from "./settings/localization.js";

export interface RendererHarnessMessages {
  readonly commands: string;
  readonly harnessCommands: string;
  readonly commandsUnavailable: string;
  readonly commandRequiresConversation: string;
  readonly textArgument: string;
  readonly permissionMode: string;
  readonly permissions: string;
  readonly loadingPermissions: string;
  readonly selecting: string;
  readonly permissionsUnavailable: string;
  readonly permissionModeFixedAtCreate: string;
}

const ENGLISH_HARNESS_MESSAGES: RendererHarnessMessages = Object.freeze({
  commands: "Commands",
  harnessCommands: "Harness commands",
  commandsUnavailable: "No Harness commands available yet",
  commandRequiresConversation: "Start a conversation before running this command",
  textArgument: "Text",
  permissionMode: "Permission mode",
  permissions: "Permissions",
  loadingPermissions: "Loading permissions...",
  selecting: "Selecting...",
  permissionsUnavailable: "Permissions unavailable",
  permissionModeFixedAtCreate:
    "Grok fixes its Permission Mode when the Session is created. Start a new Thread to change it.",
});

const CHINESE_HARNESS_MESSAGES: RendererHarnessMessages = Object.freeze({
  commands: "命令",
  harnessCommands: "Harness 命令",
  commandsUnavailable: "暂无可用的 Harness 命令",
  commandRequiresConversation: "请先开始对话，再执行此命令",
  textArgument: "文本",
  permissionMode: "权限模式",
  permissions: "权限",
  loadingPermissions: "正在加载权限...",
  selecting: "正在选择...",
  permissionsUnavailable: "权限不可用",
  permissionModeFixedAtCreate: "Grok 的权限模式在会话创建时确定，如需更改请新建会话",
});

// Some Harness catalogs expose preset IDs as labels. Keep IDs untouched and
// normalize only these known display labels before applying the UI locale.
const ENGLISH_PERMISSION_MODE_LABELS = new Map<string, string>([
  ["read-only", "Read only"],
  ["workspace-write", "Workspace write"],
  ["danger-full-access", "Full access (dangerous)"],
]);

const CHINESE_PERMISSION_MODE_LABELS = new Map<string, string>([
  ["Always ask", "始终询问"],
  ["Write", "写入"],
  ["Full access", "完全访问"],
  ["Plan mode", "规划模式"],
  ["Default", "默认"],
  ["Accept edits", "接受编辑"],
  ["Auto mode", "自动模式"],
  ["Bypass permissions", "绕过权限"],
  ["Ask", "询问"],
  ["Auto", "自动"],
  ["Always approve", "始终批准"],
  ["Allow all", "全部允许"],
  ["Read only", "只读"],
  ["Workspace write", "工作区写入"],
  ["Full access (dangerous)", "完全访问（危险）"],
  ["Configured permissions", "使用已配置权限"],
  ["Skip permissions", "跳过权限检查"],
  ["Always Ask", "始终询问"],
  ["Accept Edits", "接受编辑"],
  ["Plan", "规划模式"],
  ["Don't Ask", "不询问"],
  ["Bypass Permissions", "绕过权限"],
  ["Full Access", "完全访问"],
  ["Delegate", "由父会话管理"],
]);

const CHINESE_PERMISSION_MODE_DESCRIPTIONS = new Map<string, string>([
  [
    "Automatically allow reads and ask before write or execution actions.",
    "自动允许读取；写入或执行操作前询问。",
  ],
  [
    "Automatically allow reads and writes; ask before execution actions.",
    "自动允许读取和写入；执行操作前询问。",
  ],
  ["Run all tool actions without approval prompts.", "无需批准提示即可运行所有工具操作。"],
  [
    "Explore and prepare a plan; approval exits planning and resumes the previous permission mode.",
    "探索并制定计划；批准计划后退出规划，恢复此前的权限模式。",
  ],
  ["Ask before edits and other protected actions.", "编辑和其他受保护操作前询问。"],
  ["Allow file edits and ask for other protected actions.", "允许文件编辑；其他受保护操作前询问。"],
  ["Let Claude classify permission requests.", "由 Claude 判断权限请求。"],
  ["Skip Claude Code permission checks.", "跳过 Claude Code 权限检查。"],
  [
    "Use Grok Build's default interactive approval policy.",
    "使用 Grok Build 的默认交互式批准策略。",
  ],
  ["Ask before protected tool actions.", "执行受保护的工具操作前询问。"],
  [
    "Let Grok Build decide which tool actions may run automatically.",
    "由 Grok Build 决定哪些工具操作可自动运行。",
  ],
  ["Approve all tool actions without prompting.", "无需提示即可批准所有工具操作。"],
  ["Use OpenCode's configured permission rules.", "使用 OpenCode 已配置的权限规则。"],
  ["Ask before protected OpenCode actions.", "执行受保护的 OpenCode 操作前询问。"],
  ["Allow OpenCode actions without approval prompts.", "允许 OpenCode 操作，无需批准提示。"],
  [
    "Use Antigravity CLI permission rules; headless prompts are denied safely.",
    "使用 Antigravity CLI 权限规则；无界面运行时安全拒绝需要交互确认的请求。",
  ],
  ["Auto-approve every Antigravity CLI tool action.", "自动批准所有 Antigravity CLI 工具操作。"],
  ["Prompts for permission on first use of each tool", "首次使用每种工具时请求权限。"],
  [
    "Automatically accepts file edit permissions for the session",
    "自动接受本会话中的文件编辑权限。",
  ],
  [
    "Agent can analyze but not modify files or execute commands",
    "Agent 可以分析，但不能修改文件或执行命令。",
  ],
  [
    "An AI classifier reviews actions that would normally prompt: safe ones are auto-approved, risky ones are denied. If the classifier is unavailable, the action falls back to a prompt (or is denied when prompts cannot be shown)",
    "由 AI 分类器评估原本需要询问的操作：安全操作自动批准，风险操作拒绝。分类器不可用时改为询问；无法显示询问时拒绝。",
  ],
  [
    "Does not show permission prompts; pre-approved and safe read-only actions run, everything else that would prompt is denied",
    "不显示权限询问；已获批准和安全的只读操作可以执行，其余原本需要询问的操作会被拒绝。",
  ],
  ["Skips all permission prompts", "跳过常规权限询问。"],
  [
    "Skips ALL permission checks including dangerous commands for all agents",
    "为所有 Agent 跳过全部权限检查，包括危险命令。",
  ],
  ["Permissions managed by parent session", "由父会话管理权限。"],
  [
    "Native agent mode with Cursor tool approvals",
    "执行任务，可修改文件和运行命令；需要审批的操作仍会请求确认。",
  ],
  ["Native read-only planning mode", "只读分析代码并制定实施计划，不修改项目文件。"],
  ["Native read-only question mode", "只读查看代码并回答问题，不修改项目文件。"],
]);

export function rendererHarnessMessages(locale: RendererSettingsLocale): RendererHarnessMessages {
  return locale === "zh-CN" ? CHINESE_HARNESS_MESSAGES : ENGLISH_HARNESS_MESSAGES;
}

export function rendererHarnessCommandPresentation(
  command: HarnessCommandDescriptor,
  locale: RendererSettingsLocale,
): { label: string; description: string } {
  if (locale === "zh-CN" && command.invocation === "/compact") {
    return { label: "压缩上下文", description: "压缩当前对话上下文" };
  }
  return {
    label: command.label,
    description: command.description ?? command.label,
  };
}

export function rendererPermissionModePresentation(
  mode: HarnessPermissionMode,
  locale: RendererSettingsLocale,
): { label: string; description: string | undefined } {
  const label = ENGLISH_PERMISSION_MODE_LABELS.get(mode.label) ?? mode.label;
  if (locale !== "zh-CN") return { label, description: mode.description };
  return {
    label: CHINESE_PERMISSION_MODE_LABELS.get(label) ?? label,
    description:
      mode.description === undefined
        ? undefined
        : (CHINESE_PERMISSION_MODE_DESCRIPTIONS.get(mode.description) ?? mode.description),
  };
}
