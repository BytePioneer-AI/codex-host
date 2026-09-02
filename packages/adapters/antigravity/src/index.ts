import { packageMetadata as harnessAdapter } from "@codexhost/harness-adapter";
import { WORKSPACE_CONTRACT_VERSION } from "@codexhost/shared-contracts";

export {
  AntigravityAdapter,
  parseAntigravityContextUsage,
  permissionDeniedTurnError,
} from "./antigravity-adapter.js";
export type { AntigravityAdapterOptions } from "./antigravity-adapter.js";
export { resolveAntigravityExecutable } from "./command.js";
export {
  antigravityAvailableThinkingOptions,
  antigravityModelArguments,
  parseAntigravityModels,
} from "./model-catalog.js";
export { fetchAntigravityQuota, parseAntigravityUsageCommand } from "./quota.js";
export type {
  AntigravityCommandRunner,
  AntigravityQuotaBucket,
  AntigravityQuotaSnapshot,
} from "./quota.js";
export {
  antigravityToolErrorMessage,
  isAntigravityPermissionDenial,
  parseAntigravityStreamLine,
} from "./stream-events.js";
export type { AntigravityStreamEvent } from "./stream-events.js";

export const packageMetadata = {
  name: "@codexhost/adapter-antigravity",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
  adapterContract: harnessAdapter.name,
} as const;
