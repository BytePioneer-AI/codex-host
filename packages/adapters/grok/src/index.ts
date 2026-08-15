import { WORKSPACE_CONTRACT_VERSION } from "@codexhost/shared-contracts";

export { GrokAdapter } from "./grok-adapter.js";
export type {
  GrokAdapterDependencies,
  GrokAdapterOptions,
  GrokAcpTransportLike,
} from "./grok-adapter.js";
export { fetchGrokCredits, parseGrokCreditsResponse } from "./grok-credits.js";
export type { GrokCreditsSnapshot, GrokProductUsage } from "./grok-credits.js";
export { GrokAcpTransport, GrokTransportError } from "./acp-transport.js";
export type {
  GrokAcpTransportOptions,
  GrokOpenResult,
  GrokPermissionRequest,
  GrokTransportEvent,
} from "./acp-transport.js";
export { GrokExecutableError, resolveGrokExecutable } from "./command.js";

export const packageMetadata = {
  name: "@codexhost/adapter-grok",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
} as const;
