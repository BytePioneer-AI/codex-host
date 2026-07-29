import { WORKSPACE_CONTRACT_VERSION } from "@codexhost/shared-contracts";

export {
  CdpClient,
  getCdpBrowserVersion,
  listCdpTargets,
  waitForRendererTarget,
} from "./cdp-client.js";
export type {
  CdpBrowserVersion,
  CdpClientOptions,
  CdpEventListener,
  CdpFetch,
  CdpFetchResponse,
  CdpSocketFactory,
  CdpTarget,
} from "./cdp-client.js";
export { inspectRendererDom, validateRendererDomInspection } from "./renderer-dom.js";
export type {
  RendererDomInspection,
  RendererDomNodeSummary,
  RendererShadowRootSummary,
} from "./renderer-dom.js";
export {
  installMainProcessTitlePolicy,
  markRendererTitlePolicyReady,
  readMainProcessTitlePolicyCounters,
} from "./main-process-title-policy.js";
export type {
  MainProcessTitlePolicyCounters,
  MainProcessTitlePolicyStatus,
  RendererTitlePolicyReadiness,
} from "./main-process-title-policy.js";

export const packageMetadata = {
  name: "@codexhost/desktop-control",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
} as const;
