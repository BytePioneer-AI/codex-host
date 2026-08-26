import { packageMetadata as harnessAdapter } from "@codexhost/harness-adapter";
import { WORKSPACE_CONTRACT_VERSION } from "@codexhost/shared-contracts";

export { OmpAdapter } from "./omp-adapter.js";
export type { OmpAdapterOptions } from "./omp-adapter.js";
export const packageMetadata = {
  name: "@codexhost/adapter-omp",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
  adapterContract: harnessAdapter.name,
} as const;
