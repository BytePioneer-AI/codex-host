import { WORKSPACE_CONTRACT_VERSION } from "@codexhost/shared-contracts";

export { QwenCodeAdapter } from "./qwen-code-adapter.js";
export type {
  QwenCodeAdapterDependencies,
  QwenCodeAdapterOptions,
  QwenCodeAcpTransportLike,
} from "./qwen-code-adapter.js";
export { QwenCodeAcpTransport, QwenCodeTransportError } from "./acp-transport.js";
export type {
  QwenCodeAcpTransportOptions,
  QwenCodeOpenInput,
  QwenCodeOpenResult,
  QwenCodePermissionRequest,
  QwenCodeTransportEvent,
  QwenCodeTransportFaultKind,
} from "./acp-transport.js";
export {
  QWEN_CODE_DEFAULT_PERMISSION_MODE_ID,
  QWEN_CODE_PERMISSION_MODE_CATALOG,
  currentQwenCodePermissionModeId,
  decodeQwenCodePermissionModeId,
} from "./permission-modes.js";
export type { QwenCodePermissionMode } from "./permission-modes.js";
export {
  nativeModelIdForRef,
  parseQwenCodeModelState,
  sanitizeQwenCodeModelRefId,
} from "./qwen-models.js";
export type { QwenCodeModelState } from "./qwen-models.js";
export { mapQwenCodeReplay, qwenCodeTurnKey } from "./qwen-history.js";
export { projectQwenCodeFileChanges } from "./qwen-file-change.js";
export { combineUsage, usageFromUpdate, usageFromMetadata } from "./qwen-usage.js";
export { QwenCodeExecutableError, qwenDiscoverySpec, resolveQwenExecutable } from "./command.js";

export const packageMetadata = {
  name: "@codexhost/adapter-qwen-code",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
} as const;
