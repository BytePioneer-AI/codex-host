import { WORKSPACE_CONTRACT_VERSION } from "@codexhost/shared-contracts";

export { GeminiAdapter } from "./gemini-adapter.js";
export type {
  GeminiAdapterDependencies,
  GeminiAdapterOptions,
  GeminiAcpTransportLike,
} from "./gemini-adapter.js";
export { fetchGeminiCredits, parseGeminiCreditsResponse } from "./gemini-credits.js";
export type { GeminiCreditsSnapshot, GeminiProductUsage } from "./gemini-credits.js";
export {
  GeminiAcpTransport,
  GeminiTransportError,
  locateGeminiNativeSession,
  readGeminiNativeHistory,
} from "./acp-transport.js";
export type {
  GeminiAcpTransportOptions,
  GeminiForkOpenInput,
  GeminiNativeSessionLocation,
  GeminiOpenInput,
  GeminiOpenResult,
  GeminiPermissionRequest,
  GeminiRewindOpenInput,
  GeminiTransportEvent,
} from "./acp-transport.js";
export {
  GEMINI_SESSION_FORK_METHOD,
  buildGeminiForkParams,
  parseGeminiForkResponse,
} from "./gemini-fork.js";
export type { GeminiForkParams, GeminiForkResponse } from "./gemini-fork.js";
export {
  GEMINI_DEFAULT_PERMISSION_MODE_ID,
  GEMINI_PERMISSION_MODE_CATALOG,
  decodeGeminiPermissionModeId,
  geminiPermissionModeNotification,
  geminiPermissionModeSessionMeta,
} from "./permission-modes.js";
export type { GeminiPermissionMode } from "./permission-modes.js";
export {
  GEMINI_REWIND_EXECUTE_METHOD,
  GEMINI_REWIND_POINTS_METHOD,
  buildGeminiRewindParams,
  parseGeminiRewindResponse,
} from "./gemini-rewind.js";
export type { GeminiRewindParams, GeminiRewindResponse } from "./gemini-rewind.js";
export { GeminiExecutableError, resolveGeminiExecutable } from "./command.js";

export const packageMetadata = {
  name: "@codexhost/adapter-gemini",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
} as const;
