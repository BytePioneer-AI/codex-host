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
  readonly modelSelectionRejected: string;
  readonly thinkingSelectionRejected: string;
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
  modelSelectionRejected: "Couldn't switch Model",
  thinkingSelectionRejected: "Couldn't switch Thinking option",
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
  modelSelectionRejected: "无法切换模型",
  thinkingSelectionRejected: "无法切换思考选项",
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

/** Workspace commands and skills can require a running native Session. */
export function rendererLiveCommandsPendingNotice(
  locale: RendererSettingsLocale,
  harnessLabel: string,
): string {
  const harness = harnessLabel.replace(/\s*[(（][^)）]*[)）]\s*$/u, "").trim() || harnessLabel;
  return locale === "zh-CN"
    ? `发送一条消息后，会加载 ${harness} 在当前项目的全部命令和技能`
    : `Send a message to load all ${harness} commands and skills for this project`;
}
