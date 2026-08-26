import { packageMetadata as harnessAdapter } from "@codexhost/harness-adapter";
import { WORKSPACE_CONTRACT_VERSION } from "@codexhost/shared-contracts";

export { OmpAdapter } from "./omp-adapter.js";
export type { OmpAdapterOptions } from "./omp-adapter.js";
export type {
  OmpHostToolContent,
  OmpHostToolCall,
  OmpHostToolDefinition,
  OmpHostToolLoadMode,
  OmpHostToolRegistration,
  OmpHostToolResult,
  OmpHostToolUpdate,
  OmpHostUriContentType,
  OmpHostUriRegistration,
  OmpHostUriRequest,
  OmpHostUriResult,
  OmpHostUriSchemeDefinition,
} from "./omp-host-bridge.js";
export type { OmpExtensionUiHandlers, OmpExtensionUiRequest } from "./omp-extension-ui.js";

export const packageMetadata = {
  name: "@codexhost/adapter-omp",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
  adapterContract: harnessAdapter.name,
} as const;
