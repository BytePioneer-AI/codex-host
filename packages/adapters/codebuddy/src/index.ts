import { packageMetadata as harnessAdapter } from "@codexhost/harness-adapter";
import { WORKSPACE_CONTRACT_VERSION } from "@codexhost/shared-contracts";

export { CodeBuddyAdapter, CODEBUDDY_HARNESS_ID } from "./codebuddy-adapter.js";
export type { CodeBuddyAdapterDependencies, CodeBuddyAdapterOptions } from "./codebuddy-adapter.js";
export { codebuddyDiscoverySpec, resolveCodeBuddyExecutable } from "./command.js";
export type { CodeBuddyExecutableDependencies } from "./command.js";
export { codebuddyProjectSlug, readCodeBuddyTranscript } from "./history.js";
export {
  parseModelCatalogFromHelp,
  resolveModelCatalogFromCli,
  staticModelCatalog,
} from "./model-catalog.js";
export {
  CODEBUDDY_DEFAULT_PERMISSION_MODE_ID,
  CODEBUDDY_PERMISSION_MODE_CATALOG,
  isKnownCodeBuddyPermissionModeId,
} from "./permission-modes.js";
export {
  CodeBuddyStreamProcess,
  codebuddySpawnArgs,
  codebuddyUserFrame,
  initInfoFromFrame,
  parseCodeBuddyStreamFrame,
} from "./stream-protocol.js";
export type {
  CodeBuddyProcessExit,
  CodeBuddySpawnOptions,
  CodeBuddyStreamFrame,
  CodeBuddyTurnResult,
  SpawnDependency,
} from "./stream-protocol.js";

export const packageMetadata = {
  name: "@codexhost/adapter-codebuddy",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
  adapterContract: harnessAdapter.name,
} as const;
