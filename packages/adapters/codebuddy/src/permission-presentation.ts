import type { HarnessLocalizations } from "@codexhost/shared-contracts";

// Native ACP labels/descriptions may be customized. Translate only wording this
// Adapter knows; never infer semantics from a familiar ID with unknown wording.
const labels: Readonly<Record<string, string>> = {
  "Always Ask": "始终询问",
  "Accept Edits": "接受编辑",
  Plan: "规划模式",
  Auto: "自动",
  "Auto mode": "自动模式",
  "Don't Ask": "不询问",
  "Bypass Permissions": "绕过权限",
  "Full Access": "完全访问",
  Delegate: "由父会话管理",
  Default: "默认",
};
const descriptions: Readonly<Record<string, string>> = {
  "Prompts for permission on first use of each tool": "首次使用每种工具时请求权限。",
  "Automatically accepts file edit permissions for the session": "自动接受本会话中的文件编辑权限。",
  "Agent can analyze but not modify files or execute commands":
    "Agent 可以分析，但不能修改文件或执行命令。",
  "An AI classifier reviews actions that would normally prompt: safe ones are auto-approved, risky ones are denied. If the classifier is unavailable, the action falls back to a prompt (or is denied when prompts cannot be shown)":
    "由 AI 分类器评估原本需要询问的操作：安全操作自动批准，风险操作拒绝。分类器不可用时改为询问；无法显示询问时拒绝。",
  "Does not show permission prompts; pre-approved and safe read-only actions run, everything else that would prompt is denied":
    "不显示权限询问；已获批准和安全的只读操作可以执行，其余原本需要询问的操作会被拒绝。",
  "Skips all permission prompts": "跳过常规权限询问。",
  "Skips ALL permission checks including dangerous commands for all agents":
    "为所有 Agent 跳过全部权限检查，包括危险命令。",
  "Permissions managed by parent session": "由父会话管理权限。",
};

export function permissionLocalizations(label: string, description: string): HarnessLocalizations {
  const localizedLabel = Object.hasOwn(labels, label) ? labels[label] : undefined;
  const localizedDescription = Object.hasOwn(descriptions, description)
    ? descriptions[description]
    : undefined;
  return {
    "zh-CN": {
      ...(localizedLabel ? { label: localizedLabel } : {}),
      ...(localizedDescription ? { description: localizedDescription } : {}),
    },
  };
}
