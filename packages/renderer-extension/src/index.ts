import { WORKSPACE_CONTRACT_VERSION } from "@codexhost/shared-contracts/version";

export { AgentSelectionRegistry } from "./agent-selection-state.js";
export type {
  AgentSelectionRegistryOptions,
  ComposerAgentPhase,
  RendererAgent,
  RendererSubmissionObservation,
  SubmissionTrigger,
} from "./agent-selection-state.js";
export { installRendererBindingProbe } from "./renderer-binding-probe.js";
export type {
  RendererBindingProbeApi,
  RendererBindingProbeStatus,
} from "./renderer-binding-probe.js";
export {
  decorateThreadStartParams,
  describePrewarmTargets,
  findActivePrewarmTargets,
  findPrewarmTargets,
  installCurrentRendererAdapter,
  PI_TRANSPORT_MODEL_ID,
  SUPPORTED_DESKTOP_PACKAGE_VERSION,
  SUPPORTED_RENDERER_ASSET,
  wrapElectronRendererBridge,
  wrapPrewarmDispatcher,
  wrapPrewarmTarget,
} from "./versioned-renderer-adapter.js";
export type {
  LockedComposerSelection,
  RendererAdapterCandidateShape,
  RendererAdapterState,
  RendererAdapterStatus,
} from "./versioned-renderer-adapter.js";

export const rendererBuildMetadata = {
  name: "@codexhost/renderer-extension",
  target: "browser",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
} as const;
