import { packageMetadata as harnessAdapter } from "@codexhost/harness-adapter";
import { WORKSPACE_CONTRACT_VERSION } from "@codexhost/shared-contracts";

export { QoderAdapter } from "./adapter.js";
export type { QoderAdapterOptions } from "./adapter.js";
export { QoderSdkTransport } from "./sdk-transport.js";
export { parseQoderSdkModels, qoderModelRef, decodeQoderModelRef } from "./models.js";
export { QODER_THINKING_OPTIONS } from "./thinking.js";
export { QODER_PERMISSION_MODE_CATALOG } from "./permission-modes.js";

export const packageMetadata = {
  name: "@codexhost/adapter-qodercli",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
  adapterContract: harnessAdapter.name,
} as const;
