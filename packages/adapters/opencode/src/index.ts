import { packageMetadata as harnessAdapter } from "@codexhost/harness-adapter";
import { WORKSPACE_CONTRACT_VERSION } from "@codexhost/shared-contracts";

export { OpenCodeAdapter } from "./opencode-adapter.js";
export type { OpenCodeAdapterDependencies, OpenCodeAdapterOptions } from "./opencode-adapter.js";
export { managedOpenCodeEnvironment } from "./sdk-transport.js";
export type { OpenCodeServerDependencies, OpenCodeServerOptions } from "./sdk-transport.js";

export const packageMetadata = {
  name: "@codexhost/adapter-opencode",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
  adapterContract: harnessAdapter.name,
} as const;
