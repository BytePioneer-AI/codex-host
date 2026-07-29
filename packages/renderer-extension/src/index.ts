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
  installRendererBindingProbe,
  shouldTransferComposerState,
} from "./renderer-binding-probe.js";
export type {
  RendererBindingProbeApi,
  RendererBindingProbeOptions,
  RendererBindingProbeStatus,
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
  modelSelectionForAgent,
  PI_TRANSPORT_MODEL_ID,
  selectOptimisticModelAtom,
  SUPPORTED_DESKTOP_PACKAGE_VERSION,
  SUPPORTED_RENDERER_ASSET,
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

export const rendererBuildMetadata = {
  name: "@codexhost/renderer-extension",
  target: "browser",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
} as const;
