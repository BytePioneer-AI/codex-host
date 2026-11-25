import {
  localizeHarnessPresentation,
  type HarnessCommandDescriptor,
  type HarnessPermissionMode,
} from "@codexhost/shared-contracts";

import type { RendererSettingsLocale } from "./settings/localization.js";

export interface RendererHarnessMessages {
  readonly commands: string;
  readonly harnessCommands: string;
  readonly commandsUnavailable: string;
  readonly commandRequiresConversation: string;
  readonly commandMenuHint: string;
  readonly textArgument: string;
  readonly permissionMode: string;
  readonly permissions: string;
  readonly loadingPermissions: string;
  readonly selecting: string;
  readonly permissionsUnavailable: string;
  readonly permissionModeFixedAtCreate: string;
  readonly codexUsageGateUnavailable: string;
  readonly modelMenuTitle: string;
  readonly refreshModels: string;
  readonly modelSelectionRejected: string;
  readonly thinkingSelectionRejected: string;
  readonly handoffAction: string;
  readonly handoffTitle: string;
  readonly handoffTargetHarnessLabel: string;
  readonly handoffTargetModelLabel: string;
  readonly handoffDefaultModelOption: string;
  readonly handoffTargetThinkingLabel: string;
  readonly handoffDefaultThinkingOption: string;
  readonly handoffLoadingModels: string;
  readonly handoffConfirm: string;
  readonly handoffSubmitting: string;
  readonly handoffCancel: string;
  readonly handoffOpenSourceThread: string;
  readonly handoffPreviewLabel: string;
  readonly handoffFailed: string;
}

const ENGLISH_HARNESS_MESSAGES: RendererHarnessMessages = Object.freeze({
  commands: "Commands",
  harnessCommands: "Harness commands",
  commandsUnavailable: "No Harness commands available yet",
  commandRequiresConversation: "Start a conversation before running this command",
  commandMenuHint: "Type # for commands, skills and agents",
  textArgument: "Text",
  permissionMode: "Permission mode",
  permissions: "Permissions",
  loadingPermissions: "Loading permissions...",
  selecting: "Selecting...",
  permissionsUnavailable: "Permissions unavailable",
  permissionModeFixedAtCreate:
    "This Permission Mode is fixed when the Session is created. Start a new Thread to change it.",
  codexUsageGateUnavailable:
    "Could not separate this Harness from the Codex usage limit in this Desktop version. Codex usage limits still apply to sending.",
  modelMenuTitle: "Model",
  refreshModels: "Refresh models",
  modelSelectionRejected: "Couldn't switch Model",
  thinkingSelectionRejected: "Couldn't switch Thinking option",
  handoffAction: "Handoff context",
  handoffTitle: "Context handoff",
  handoffTargetHarnessLabel: "Target Harness",
  handoffTargetModelLabel: "Model (optional)",
  handoffDefaultModelOption: "Default model",
  handoffTargetThinkingLabel: "Thinking (optional)",
  handoffDefaultThinkingOption: "Default thinking",
  handoffLoadingModels: "Loading models…",
  handoffConfirm: "Handoff",
  handoffSubmitting: "Handing off…",
  handoffCancel: "Cancel",
  handoffOpenSourceThread: "Open source thread",
  handoffPreviewLabel: "Context preview",
  handoffFailed: "Context handoff failed",
});

const CHINESE_HARNESS_MESSAGES: RendererHarnessMessages = Object.freeze({
  commands: "命令",
  harnessCommands: "Harness 命令",
  commandsUnavailable: "暂无可用的 Harness 命令",
  commandRequiresConversation: "请先开始对话，再执行此命令",
  commandMenuHint: "输入 # 打开命令、技能和 Agent",
  textArgument: "文本",
  permissionMode: "权限模式",
  permissions: "权限",
  loadingPermissions: "正在加载权限...",
  selecting: "正在选择...",
  permissionsUnavailable: "权限不可用",
  permissionModeFixedAtCreate: "此权限模式在会话创建时确定，如需更改请新建会话",
  codexUsageGateUnavailable:
    "当前 Desktop 版本无法将此 Harness 与 Codex 额度限制分离，发送仍受 Codex 额度限制",
  modelMenuTitle: "模型",
  refreshModels: "刷新模型列表",
  modelSelectionRejected: "无法切换模型",
  thinkingSelectionRejected: "无法切换思考选项",
  handoffAction: "上下文交接",
  handoffTitle: "上下文交接",
  handoffTargetHarnessLabel: "目标 Harness",
  handoffTargetModelLabel: "模型（可选）",
  handoffDefaultModelOption: "默认模型",
  handoffTargetThinkingLabel: "思考档位（可选）",
  handoffDefaultThinkingOption: "默认思考档位",
  handoffLoadingModels: "正在加载模型…",
  handoffConfirm: "确认交接",
  handoffSubmitting: "正在交接…",
  handoffCancel: "取消",
  handoffOpenSourceThread: "跳回源会话",
  handoffPreviewLabel: "交接上下文预览",
  handoffFailed: "上下文交接失败",
});

export function rendererHarnessMessages(locale: RendererSettingsLocale): RendererHarnessMessages {
  return locale === "zh-CN" ? CHINESE_HARNESS_MESSAGES : ENGLISH_HARNESS_MESSAGES;
}

export function rendererHarnessCommandPresentation(
  command: HarnessCommandDescriptor,
  locale: RendererSettingsLocale,
): { label: string; description: string } {
  const presentation = localizeHarnessPresentation(command, locale);
  return { ...presentation, description: presentation.description ?? presentation.label };
}

export function rendererPermissionModePresentation(
  mode: HarnessPermissionMode,
  locale: RendererSettingsLocale,
): { label: string; description: string | undefined } {
  return localizeHarnessPresentation(mode, locale);
}

/** Workspace commands can require a running native Session. */
export function rendererLiveCommandsPendingNotice(
  locale: RendererSettingsLocale,
  harnessLabel: string,
): string {
  const harness = harnessLabel.replace(/\s*[(（][^)）]*[)）]\s*$/u, "").trim() || harnessLabel;
  return locale === "zh-CN"
    ? `发送一条消息后，会加载 ${harness} 在当前项目的全部命令`
    : `Send a message to load all ${harness} commands for this project`;
}

export function formatRendererHandoffTurnsSummary(
  locale: RendererSettingsLocale,
  input: {
    includedCount: number;
    totalTurns: number;
    omittedTurns: number;
    boundaryTurnNumber: number;
  },
): string {
  if (locale === "zh-CN") {
    if (input.omittedTurns > 0) {
      return `已携带 ${input.includedCount} / ${input.totalTurns} 轮上下文（已省略 ${input.omittedTurns} 轮，截至第 ${input.boundaryTurnNumber} 轮）`;
    }
    return `已携带全部 ${input.includedCount} / ${input.totalTurns} 轮上下文`;
  }
  if (input.omittedTurns > 0) {
    return `Carried ${input.includedCount} of ${input.totalTurns} turns (${input.omittedTurns} omitted, up to turn ${input.boundaryTurnNumber})`;
  }
  return `Carried all ${input.includedCount} of ${input.totalTurns} turns`;
}
