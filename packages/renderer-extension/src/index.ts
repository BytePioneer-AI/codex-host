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
  HARNESS_INSPECT_METHOD,
  THREAD_MODEL_SELECT_METHOD,
  createRendererModelClient,
} from "./renderer-model-client.js";
export type { RendererModelClient } from "./renderer-model-client.js";
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
  isPiTransportModelId,
  modelSelectionForAgent,
  piTransportModelId,
  PI_TRANSPORT_MODEL_ID,
  PI_TRANSPORT_MODEL_PREFIX,
  selectOptimisticModelAtom,
  SUPPORTED_DESKTOP_PACKAGE_VERSION,
  SUPPORTED_RENDERER_ASSET,
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

export const rendererBuildMetadata = {
  name: "@codexhost/renderer-extension",
  target: "browser",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
} as const;
