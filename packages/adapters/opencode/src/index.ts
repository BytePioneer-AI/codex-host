import { WORKSPACE_CONTRACT_VERSION } from "@codexhost/shared-contracts";

export { OpenCodeAdapter } from "./opencode-adapter.js";
export type {
  OpenCodeAdapterDependencies,
  OpenCodeAdapterOptions,
  OpenCodeAcpTransportLike,
} from "./opencode-adapter.js";
export { OpenCodeAcpTransport, OpenCodeTransportError } from "./acp-transport.js";
export type {
  OpenCodeAcpTransportOptions,
  OpenCodeOpenResult,
  OpenCodePermissionRequest,
  OpenCodeTransportEvent,
} from "./acp-transport.js";
export { OpenCodeExecutableError, resolveOpenCodeExecutable } from "./command.js";
export { openCodeDatabasePath, readOpenCodeHistory } from "./opencode-storage.js";
export type { OpenCodeStoredSession } from "./opencode-storage.js";
export { mapOpenCodeMessages } from "./opencode-history.js";
export type { OpenCodeMessage, OpenCodePart } from "./opencode-history.js";

export const packageMetadata = {
  name: "@codexhost/adapter-opencode",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
} as const;
