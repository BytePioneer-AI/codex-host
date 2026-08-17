import { WORKSPACE_CONTRACT_VERSION } from "@codexhost/shared-contracts";

export { GrokAdapter } from "./grok-adapter.js";
export type {
  GrokAdapterDependencies,
  GrokAdapterOptions,
  GrokAcpTransportLike,
} from "./grok-adapter.js";
export { fetchGrokCredits, parseGrokCreditsResponse } from "./grok-credits.js";
export type { GrokCreditsSnapshot, GrokProductUsage } from "./grok-credits.js";
export {
  GrokAcpTransport,
  GrokTransportError,
  locateGrokNativeSession,
  readGrokNativeHistory,
} from "./acp-transport.js";
export type {
  GrokAcpTransportOptions,
  GrokForkOpenInput,
  GrokNativeSessionLocation,
  GrokOpenInput,
  GrokOpenResult,
  GrokPermissionRequest,
  GrokRewindOpenInput,
  GrokTransportEvent,
} from "./acp-transport.js";
export {
  GROK_SESSION_FORK_METHOD,
  buildGrokForkParams,
  parseGrokForkResponse,
} from "./grok-fork.js";
export type { GrokForkParams, GrokForkResponse } from "./grok-fork.js";
export {
  GROK_REWIND_EXECUTE_METHOD,
  GROK_REWIND_POINTS_METHOD,
  buildGrokRewindParams,
  parseGrokRewindResponse,
} from "./grok-rewind.js";
export type { GrokRewindParams, GrokRewindResponse } from "./grok-rewind.js";
export { GrokExecutableError, resolveGrokExecutable } from "./command.js";

export const packageMetadata = {
  name: "@codexhost/adapter-grok",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
} as const;
