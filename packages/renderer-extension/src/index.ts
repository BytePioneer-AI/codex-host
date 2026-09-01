import { WORKSPACE_CONTRACT_VERSION } from "@codexhost/shared-contracts/version";

export { readCodexLocaleSettings, setCodexLocaleOverride } from "./codex-locale-adapter.js";
export type {
  CodexLocaleMode,
  CodexLocaleOverride,
  CodexLocaleReadStatus,
  CodexLocaleRequestOptions,
  CodexLocaleSettings,
  CodexLocaleSource,
  ReadCodexLocaleSettingsOptions,
  SetCodexLocaleOverrideOptions,
} from "./codex-locale-adapter.js";

export {
  DEFAULT_RENDERER_AGENTS,
  DraftAgentController,
  KNOWN_RENDERER_AGENTS,
} from "./agent-selection-state.js";
export type {
  ComposerAgentPhase,
  DraftAgentControllerOptions,
  DraftAgentSwitchOperations,
  DraftComposerState,
  ExternalRendererAgent,
  RendererAgent,
  RendererAgentAvailability,
} from "./agent-selection-state.js";
export {
  HARNESS_INSPECT_METHOD,
  THREAD_FORK_METHOD,
  THREAD_INSPECT_METHOD,
  THREAD_COMMANDS_INSPECT_METHOD,
  THREAD_COMMAND_EXECUTE_METHOD,
  THREAD_MODEL_SELECT_METHOD,
  THREAD_PERMISSION_MODE_SELECT_METHOD,
  THREAD_THINKING_SELECT_METHOD,
  THREAD_OWNERSHIP_LIST_METHOD,
  THREAD_USAGE_INSPECT_METHOD,
  UPDATE_CHECK_METHOD,
  UPDATE_START_METHOD,
  UPDATE_STATUS_METHOD,
  createRendererModelClient,
} from "./renderer-model-client.js";
export type { RendererModelClient } from "./renderer-model-client.js";
export {
  TRANSCRIPT_ITEM_IDS_ATTRIBUTE,
  TRANSCRIPT_ITEM_SELECTOR,
  TRANSCRIPT_TEXT_BODY_SELECTOR,
  inspectRendererTranscriptContract,
} from "./renderer-transcript-dom.js";
export type { RendererTranscriptContractInspection } from "./renderer-transcript-dom.js";
export {
  inspectRendererComposerContract,
  isNativeContextUsageControlCandidate,
  nativeContextUsageControlForComposer,
} from "./renderer-composer-dom.js";
export type { RendererComposerContractInspection } from "./renderer-composer-dom.js";
export {
  rendererHarnessCommandPresentation,
  rendererHarnessMessages,
  rendererPermissionModePresentation,
} from "./renderer-harness-localization.js";
export type { RendererHarnessMessages } from "./renderer-harness-localization.js";
export { mountRendererHarnessCommandControl } from "./renderer-harness-command-control.js";
export type { RendererHarnessCommandControl } from "./renderer-harness-command-control.js";
export {
  creditsPeriodLabel,
  formatRendererCreditsReset,
  rendererCreditsTone,
} from "./renderer-credits-control.js";
export {
  formatRendererCacheHitRate,
  formatRendererCost,
  formatRendererCreditsPercent,
  formatRendererTokenCount,
} from "./renderer-usage-control.js";
export {
  inspectRendererForkContract,
  installRendererForkControl,
  rendererForkTargetFromButton,
} from "./renderer-fork-control.js";
export type {
  RendererForkContractInspection,
  RendererForkControl,
  RendererForkDom,
  RendererForkTarget,
} from "./renderer-fork-control.js";
export {
  draftPermissionMode,
  installRendererBindingProbe,
  isOwnershipSubmissionBlocked,
  permissionModeSelectionLocked,
  restoredThreadOwnership,
  shouldTransferComposerState,
} from "./renderer-binding-probe.js";
export type {
  ComposerOwnershipStatus,
  RendererBindingProbeApi,
  RendererBindingProbeOptions,
  RendererBindingProbeStatus,
  RestoredThreadOwnership,
} from "./renderer-binding-probe.js";
export {
  CLAUDE_CODE_TRANSPORT_MODEL_ID,
  CLAUDE_CODE_TRANSPORT_MODEL_PREFIX,
  GROK_TRANSPORT_MODEL_ID,
  GROK_TRANSPORT_MODEL_PREFIX,
  OPENCODE_TRANSPORT_MODEL_ID,
  OPENCODE_TRANSPORT_MODEL_PREFIX,
  claudeTransportModelId,
  activeRendererDraftPrewarmPolicy,
  decodeClaudeTransportModelId,
  decodeDeepSeekHarnessTransportModelId,
  deepSeekHarnessTransportModelId,
  decodeGrokTransportModelId,
  decodeOpenCodeTransportModelId,
  decodePiTransportModelId,
  findActivePrewarmTargets,
  findComposerModelTarget,
  inspectComposerModelContract,
  installCurrentRendererAdapter,
  isClaudeTransportModelId,
  isDeepSeekHarnessTransportModelId,
  isDraftPrewarmPolicyReady,
  isMainProcessTitlePolicyReady,
  isGrokTransportModelId,
  isOpenCodeTransportModelId,
  isPiTransportModelId,
  modelSelectionForAgent,
  grokTransportModelId,
  openCodeTransportModelId,
  piTransportModelId,
  PI_TRANSPORT_MODEL_ID,
  PI_TRANSPORT_MODEL_PREFIX,
  DEEPSEEK_HARNESS_TRANSPORT_MODEL_ID,
  DEEPSEEK_HARNESS_TRANSPORT_MODEL_PREFIX,
  threadIdFromComposerModelTarget,
} from "./versioned-renderer-adapter.js";
export type {
  LockedComposerSelection,
  ModelPowerSelection,
  RendererDraftPrewarmPolicy,
  RendererAdapterState,
  RendererAdapterStatus,
  RendererComposerModelContractState,
} from "./versioned-renderer-adapter.js";
export {
  inspectRendererSidebarContract,
  SIDEBAR_AGENT_ICON_ATTRIBUTE,
  SIDEBAR_THREAD_ROW_ATTRIBUTE,
  SIDEBAR_THREAD_ROW_SELECTOR,
} from "./renderer-sidebar-agent-icons.js";
export type { RendererSidebarContractInspection } from "./renderer-sidebar-agent-icons.js";
export type {
  ExternalModelControlView,
  ExternalPermissionModeControlView,
  PiModelControlView,
} from "./renderer-composer-dom.js";
export {
  RENDERER_CONTRACT_AUDIT_SCHEMA_VERSION,
  inspectRendererContracts,
} from "./contract-audit.js";
export type {
  RendererContractAuditApi,
  RendererContractAuditInspection,
} from "./contract-audit.js";
export {
  CLAUDE_PERMISSION_MODE_PREFERENCE_KEY,
  readClaudePermissionModePreference,
  writeClaudePermissionModePreference,
} from "./renderer-permission-mode-preference.js";
export type { PermissionModePreferenceStorage } from "./renderer-permission-mode-preference.js";
export {
  isPermissionModeControlReady,
  mountRendererPermissionModePicker,
  renderRendererPermissionModePicker,
  rendererPermissionModeLabel,
} from "./renderer-permission-mode-picker.js";
export type {
  RendererPermissionModeControlView,
  RendererPermissionModePickerControl,
} from "./renderer-permission-mode-picker.js";
export {
  RendererSettingsNavigationState,
  RendererSettingsPageScope,
  createRendererSettingsPageRegistry,
} from "./settings/core.js";
export type {
  RendererSettingsAsyncHandlers,
  RendererSettingsPageDefinition,
  RendererSettingsPageMountContext,
  RendererSettingsPageRegistry,
} from "./settings/core.js";
export {
  DEFAULT_RENDERER_SETTINGS_PAGE_IDS,
  createDefaultRendererSettingsPages,
  createDefaultRendererSettingsRegistry,
} from "./settings/pages.js";
export type {
  DefaultRendererSettingsPageId,
  RendererConnectionAgentSnapshot,
  RendererConnectionDiagnostics,
  RendererConnectionHostSnapshot,
  RendererConnectionSnapshot,
  RendererUpdateClient,
} from "./settings/pages.js";
export {
  DEFAULT_RENDERER_SETTINGS_MESSAGES,
  RENDERER_SETTINGS_LANGUAGE_SELECTIONS,
  RENDERER_SETTINGS_LOCALES,
  codexLocaleOverrideForSettingsSelection,
  rendererSettingsLanguageSelection,
  rendererSettingsMessages,
  resolveRendererSettingsLocale,
} from "./settings/localization.js";
export type {
  RendererSettingsLanguageControl,
  RendererSettingsLanguageSelection,
  RendererSettingsLocale,
  RendererSettingsMessages,
  RendererSettingsWritableLanguageSelection,
} from "./settings/localization.js";
export {
  SETTINGS_SHELL_ATTRIBUTE,
  installRendererSettingsShell,
  isRendererSettingsDialogSupported,
  mountRendererSettingsShell,
} from "./settings/shell.js";
export type { RendererSettingsShell } from "./settings/shell.js";
export {
  SETTINGS_HEADER_SURFACE_SELECTOR,
  SETTINGS_TRIGGER_ATTRIBUTE,
  inspectRendererSettingsContract,
  installRendererSettingsHeaderTrigger,
  mountRendererSettingsTrigger,
  selectRendererSettingsHeaderSlot,
} from "./settings/trigger.js";
export type {
  RendererSettingsBounds,
  RendererSettingsContractInspection,
  RendererSettingsHeaderSlotCandidate,
  RendererSettingsHeaderTriggerControl,
  RendererSettingsTriggerControl,
} from "./settings/trigger.js";
export {
  RENDERER_SETTINGS_ICON_NAMES,
  createRendererSettingsIcon,
  isRendererSettingsIconName,
} from "./settings/icons.js";
export type { RendererSettingsIconName } from "./settings/icons.js";

export const rendererBuildMetadata = {
  name: "@codexhost/renderer-extension",
  target: "browser",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
} as const;
