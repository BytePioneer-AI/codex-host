import { WORKSPACE_CONTRACT_VERSION } from "@codexhost/shared-contracts/version";

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
  RendererAgent,
} from "./agent-selection-state.js";
export {
  HARNESS_INSPECT_METHOD,
  THREAD_INSPECT_METHOD,
  THREAD_MODEL_SELECT_METHOD,
  THREAD_THINKING_SELECT_METHOD,
  THREAD_OWNERSHIP_LIST_METHOD,
  createRendererModelClient,
} from "./renderer-model-client.js";
export type { RendererModelClient } from "./renderer-model-client.js";
export {
  installRendererBindingProbe,
  isOwnershipSubmissionBlocked,
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
  decorateThreadStartParams,
  describePrewarmTargets,
  findActivePrewarmTargets,
  findComposerModelTarget,
  findPrewarmTargets,
  installCurrentRendererAdapter,
  isDraftPrewarmPolicyReady,
  isMainProcessTitlePolicyReady,
  isPiTransportModelId,
  modelSelectionForAgent,
  piTransportModelId,
  PI_TRANSPORT_MODEL_ID,
  PI_TRANSPORT_MODEL_PREFIX,
  selectOptimisticModelAtom,
  threadIdFromComposerModelTarget,
  wrapElectronRendererBridge,
  wrapPrewarmDispatcher,
  wrapPrewarmTarget,
} from "./versioned-renderer-adapter.js";
export type {
  LockedComposerSelection,
  ModelAtomPair,
  ModelAtomState,
  ModelPowerSelection,
  ModelStateController,
  RendererDraftPrewarmPolicy,
  RendererAdapterCandidateShape,
  RendererAdapterState,
  RendererAdapterStatus,
} from "./versioned-renderer-adapter.js";
export type { PiModelControlView } from "./renderer-composer-dom.js";
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
export type { DefaultRendererSettingsPageId } from "./settings/pages.js";
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
  installRendererSettingsHeaderTrigger,
  mountRendererSettingsTrigger,
  selectRendererSettingsHeaderSlot,
} from "./settings/trigger.js";
export type {
  RendererSettingsBounds,
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
