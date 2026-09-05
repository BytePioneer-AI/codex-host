import { packageMetadata as harnessAdapter } from "@codexhost/harness-adapter";
import { WORKSPACE_CONTRACT_VERSION } from "@codexhost/shared-contracts";

export { ClaudeCodeAdapter } from "./claude-code-adapter.js";
export type { ClaudeCodeAdapterOptions } from "./claude-code-adapter.js";
export {
  fetchClaudeCredits,
  parseClaudeOmniRouteCredits,
  defaultOmniRouteDbPath,
} from "./claude-credits.js";
export type {
  FetchClaudeCreditsInput,
  OmniRouteCacheEntry,
  OmniRouteConnection,
  OmniRouteStorageData,
} from "./claude-credits.js";

export const packageMetadata = {
  name: "@codexhost/adapter-claude-code",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
  adapterContract: harnessAdapter.name,
} as const;
