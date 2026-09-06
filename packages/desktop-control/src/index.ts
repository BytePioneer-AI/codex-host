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
export {
  DESKTOP_CONTRACT_AUDIT_SCHEMA_VERSION,
  inspectDesktopContracts,
  validateRendererContractAuditInspection,
} from "./contract-audit.js";
export type {
  DesktopContractAuditObservation,
  InspectDesktopContractsOptions,
  RendererContractAuditInspection,
} from "./contract-audit.js";
export { inspectRendererDom, validateRendererDomInspection } from "./renderer-dom.js";
export {
  createRendererCdpControlSession,
  installRendererCdpControlSession,
  selectPrimaryRendererTarget,
} from "./renderer-cdp-control-session.js";
export type {
  InstallRendererCdpControlOptions,
  ProductionRendererStatus as RendererCdpProductionStatus,
  RendererCdpControlSession,
  RendererCdpControlSnapshot,
} from "./renderer-cdp-control-session.js";
export {
  activateElectronDesktop,
  createRendererControlSession,
  inspectElectronWebContents,
  installRendererControlSession,
  selectRendererWebContents,
  waitForInspectorTarget,
  waitForRendererTitlePolicyReady,
} from "./renderer-control-session.js";
export type {
  ElectronRendererSummary,
  InstallRendererControlOptions,
  ProductionRendererStatus,
  RendererControlSession,
  RendererControlSnapshot,
} from "./renderer-control-session.js";
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
export {
  installRendererDraftPrewarmPolicy,
  installRendererDraftPrewarmPolicyDirect,
} from "./renderer-draft-prewarm-policy.js";
export type { RendererDraftPrewarmPolicyStatus } from "./renderer-draft-prewarm-policy.js";

export {
  parseDesktopControllerArguments,
  runDesktopController,
  serializeDesktopControllerReadiness,
} from "./production-controller.js";
export type {
  DesktopControllerDependencies,
  DesktopControllerOptions,
  DesktopControllerReadiness,
} from "./production-controller.js";

export const packageMetadata = {
  name: "@codexhost/desktop-control",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
} as const;
