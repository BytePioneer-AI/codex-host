import { packageMetadata as harnessAdapter } from "@codexhost/harness-adapter";
import { WORKSPACE_CONTRACT_VERSION } from "@codexhost/shared-contracts";

export { PiAdapter } from "./pi-adapter.js";
export type { PiAdapterOptions } from "./pi-adapter.js";

export const packageMetadata = {
  name: "@codexhost/adapter-pi",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
  adapterContract: harnessAdapter.name,
} as const;
