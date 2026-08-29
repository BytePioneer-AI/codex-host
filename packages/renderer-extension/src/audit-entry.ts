import { inspectRendererContracts } from "./contract-audit.js";

window.__codexhostContractAuditV1 = Object.freeze({
  inspect: () => inspectRendererContracts(window),
});
