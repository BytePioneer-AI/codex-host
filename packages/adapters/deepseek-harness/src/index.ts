import { packageMetadata as harnessAdapter } from "@codexhost/harness-adapter";
import { WORKSPACE_CONTRACT_VERSION } from "@codexhost/shared-contracts";

export { DeepSeekHarnessAdapter } from "./deepseek-harness-adapter.js";
export type {
  DeepSeekHarnessAdapterDependencies,
  DeepSeekHarnessAdapterOptions,
  DeepSeekHostConnectionLike,
} from "./deepseek-harness-adapter.js";

export const packageMetadata = {
  name: "@codexhost/adapter-deepseek-harness",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
  adapterContract: harnessAdapter.name,
} as const;
