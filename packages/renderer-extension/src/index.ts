import { WORKSPACE_CONTRACT_VERSION } from "@codexhost/shared-contracts/version";

export { DraftAgentController } from "./agent-selection-state.js";
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
  RendererBindingProbeStatus,
} from "./renderer-binding-probe.js";
export {
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
