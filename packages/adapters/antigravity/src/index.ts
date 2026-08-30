import { packageMetadata as harnessAdapter } from "@codexhost/harness-adapter";
import { WORKSPACE_CONTRACT_VERSION } from "@codexhost/shared-contracts";

export {
  AntigravityAdapter,
  parseAntigravityModels,
  parseAntigravityStreamLine,
} from "./antigravity-adapter.js";
export type { AntigravityAdapterOptions, AntigravityStreamEvent } from "./antigravity-adapter.js";
export { resolveAntigravityExecutable } from "./command.js";

export const packageMetadata = {
  name: "@codexhost/adapter-antigravity",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
  adapterContract: harnessAdapter.name,
} as const;
