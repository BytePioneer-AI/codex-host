import { WORKSPACE_CONTRACT_VERSION } from "@codexhost/shared-contracts";

export { CursorAdapter, CURSOR_HARNESS_ID, CURSOR_SESSION_CAPABILITIES } from "./cursor-adapter.js";
export type { CursorAdapterDependencies, CursorAdapterOptions } from "./cursor-adapter.js";
export {
  CursorAcpTransport,
  CursorTransportError,
  cursorLoadSessionSupported,
  transportEvent,
} from "./acp-transport.js";
export type {
  CursorAcpTransportLike,
  CursorAcpTransportOptions,
  CursorOpenInput,
  CursorOpenResult,
  CursorPermissionRequest,
  CursorTransportEvent,
} from "./acp-transport.js";
export {
  CURSOR_COMMAND_ENV,
  CURSOR_FALLBACK_COMMAND,
  CURSOR_PREFERRED_COMMAND,
  CursorExecutableError,
  classifyCursorCliText,
  cursorInvocation,
  identifyCursorExecutable,
  resolveCursorExecutable,
  withNodeRuntimeOnPath,
} from "./command.js";
export type { CursorExecutableFault, CursorResolution } from "./command.js";

export const packageMetadata = {
  name: "@codexhost/adapter-cursor",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
} as const;
