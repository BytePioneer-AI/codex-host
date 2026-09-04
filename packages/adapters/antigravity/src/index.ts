import { packageMetadata as harnessAdapter } from "@codexhost/harness-adapter";
import { WORKSPACE_CONTRACT_VERSION } from "@codexhost/shared-contracts";

export {
  AntigravityAdapter,
  parseAntigravityContextUsage,
  permissionDeniedTurnError,
  resolveAntigravityContextWindow,
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
export {
  codeActionFileChange,
  parseAntigravityCodeActions,
  requestAntigravityTrajectorySteps,
} from "./code-action-diff.js";
export type { AntigravityCodeAction } from "./code-action-diff.js";
export {
  compactToolName,
  completeAntigravityToolItem,
  displayPath,
  isAntigravityFileMutatingTool,
  startAntigravityToolItem,
  synthesizeAntigravityCommand,
  toolTargetFile,
} from "./tool-projection.js";
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
