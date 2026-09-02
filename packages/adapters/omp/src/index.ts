import { packageMetadata as harnessAdapter } from "@codexhost/harness-adapter";
import { WORKSPACE_CONTRACT_VERSION } from "@codexhost/shared-contracts";

export { OmpAdapter } from "./omp-adapter.js";
export type { OmpAdapterOptions, OmpAdapterDependencies } from "./omp-adapter.js";
export { fetchOmpCredits, parseOmniRouteCredits, defaultOmniRouteDbPath } from "./omp-credits.js";
export type {
  FetchOmpCreditsInput,
  OmniRouteCacheEntry,
  OmniRouteConnection,
  OmniRouteStorageData,
} from "./omp-credits.js";
export {
  OMP_DEFAULT_PERMISSION_MODE_ID,
  OMP_PERMISSION_MODE_CATALOG,
  decodeOmpPermissionModeId,
  encodeOmpPermissionModeId,
} from "./omp-permission-modes.js";
export type { OmpPermissionMode } from "./omp-permission-modes.js";
export const packageMetadata = {
  name: "@codexhost/adapter-omp",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
  adapterContract: harnessAdapter.name,
} as const;
