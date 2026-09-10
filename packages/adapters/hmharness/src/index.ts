import { packageMetadata as harnessAdapter } from "@codexhost/harness-adapter";
import { WORKSPACE_CONTRACT_VERSION } from "@codexhost/shared-contracts";

export { HMHarnessAdapter } from "./hmharness-adapter.js";
export type {
  HMHarnessAdapterDependencies,
  HMHarnessAdapterOptions,
  HMHarnessBridgeResult,
  HMHarnessBridgeRunner,
} from "./hmharness-adapter.js";
export { HMHARNESS_COMMAND_ENV } from "./plugin.js";
export {
  decodeHmHarnessModelRef,
  encodeHmHarnessModelRef,
  normalizeHmHarnessModelCatalog,
  parseHmHarnessProviderCatalog,
  type HmHarnessProvider,
  type HmHarnessProviderCatalog,
} from "./model-catalog.js";

export const packageMetadata = {
  name: "@codexhost/adapter-hmharness",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
  adapterContract: harnessAdapter.name,
} as const;
