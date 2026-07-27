import { WORKSPACE_CONTRACT_VERSION } from "@codexhost/shared-contracts/version";

export { AgentSelectionRegistry } from "./agent-selection-state.js";
export type {
  AgentSelectionRegistryOptions,
  RendererAgent,
  RendererSubmissionObservation,
  SubmissionTrigger,
} from "./agent-selection-state.js";
export { installRendererBindingProbe } from "./renderer-binding-probe.js";
export type {
  RendererBindingProbeApi,
  RendererBindingProbeStatus,
} from "./renderer-binding-probe.js";

export const rendererBuildMetadata = {
  name: "@codexhost/renderer-extension",
  target: "browser",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
} as const;
