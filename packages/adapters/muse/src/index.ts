import { packageMetadata as harnessAdapter } from "@codexhost/harness-adapter";
import { WORKSPACE_CONTRACT_VERSION } from "@codexhost/shared-contracts";

export { MuseAdapter } from "./muse-adapter.js";
export type { MuseAdapterOptions } from "./muse-adapter.js";
export { resolveMuseExecutable } from "./command.js";
export { parseMuseModelCatalog } from "./model-catalog.js";
export {
  mapMuseApprovalActions,
  museApprovalProjectionReady,
  parseMuseRequirementRef,
} from "./approval.js";
export { MUSE_MSP_NOTIFICATIONS, MUSE_MSP_REQUEST_METHODS } from "./msp-surface.js";
export { museNativeTurnKey, snapshotFromMuseHistory } from "./history.js";
export { MUSE_PERMISSION_MODE_CATALOG } from "./permission-modes.js";
export { uuidv7 } from "./uuid.js";

export const packageMetadata = {
  name: "@codexhost/adapter-muse",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
  adapterContract: harnessAdapter.name,
} as const;
