import { packageMetadata as harnessAdapter } from "@codexhost/harness-adapter";
import { WORKSPACE_CONTRACT_VERSION } from "@codexhost/shared-contracts";

export {
  AntigravityAdapter,
  AntigravitySession,
  antigravitySessionCapabilities,
  normalizeAntigravityError,
} from "./antigravity-adapter.js";
export type { AntigravityAdapterOptions } from "./antigravity-adapter.js";
export { AntigravityAcpTransport } from "./acp-transport.js";
export { AntigravityTransportError, ANTIGRAVITY_MIN_ACP_VERSION } from "./acp-types.js";
export type { AntigravityAcpTransportLike, AntigravityAcpTransportOptions } from "./acp-types.js";
export { resolveAntigravityExecutable } from "./command.js";
export {
  parseAntigravityModels,
  parseAntigravityAcpModelCatalog,
  readAcpEffectiveModelState,
} from "./model-catalog.js";
export { ANTIGRAVITY_PERMISSION_MODE_CATALOG } from "./permission-modes.js";
export { fetchAntigravityQuota, parseAntigravityUsageCommand } from "./quota.js";
export type {
  AntigravityCommandRunner,
  AntigravityQuotaBucket,
  AntigravityQuotaSnapshot,
} from "./quota.js";
export {
  ANTIGRAVITY_COMMAND_CATALOG,
  findAntigravityCommandDescriptor,
  parseAndFormatAntigravityCommand,
} from "./slash-commands.js";
export const packageMetadata = {
  name: "@codexhost/adapter-antigravity",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
  adapterContract: harnessAdapter.name,
} as const;
