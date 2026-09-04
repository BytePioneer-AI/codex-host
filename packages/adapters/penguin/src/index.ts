import { packageMetadata as harnessAdapter } from "@codexhost/harness-adapter";
import { WORKSPACE_CONTRACT_VERSION } from "@codexhost/shared-contracts";

export { PenguinAdapter } from "./penguin-adapter.js";
export type { PenguinAdapterDependencies, PenguinAdapterOptions } from "./penguin-adapter.js";
export type {
  PenguinApiClient,
  PenguinConnection,
  PenguinConnectionOptions,
  PenguinRequestOptions,
  PenguinSseFrame,
} from "./penguin-api.js";
export { openPenguinConnection, PenguinApiError, PenguinConnectionError } from "./penguin-api.js";
export {
  PENGUIN_COMMAND_ENV,
  penguinDiscoverySpec,
  resolvePenguinExecutable,
  withNodeRuntimeOnPath,
} from "./command.js";
export {
  PENGUIN_DEFAULT_PERMISSION_MODE_ID,
  PENGUIN_PERMISSION_MODE_CATALOG,
  decodePenguinPermissionModeId,
  encodePenguinPermissionModeId,
  isPenguinPermissionMode,
} from "./permission-modes.js";
export type { PenguinApprovalMode } from "./permission-modes.js";
export {
  decodePenguinModelRef,
  encodePenguinModelRef,
  normalizePenguinModelCatalog,
  PENGUIN_THINKING_OPTION_IDS,
} from "./model-catalog.js";
export type {
  PenguinModelsResponse,
  PenguinNativeModelRef,
  PenguinModelInfo,
} from "./model-catalog.js";

export const packageMetadata = {
  name: "@codexhost/adapter-penguin",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
  adapterContract: harnessAdapter.name,
} as const;
