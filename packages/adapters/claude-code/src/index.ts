import { packageMetadata as harnessAdapter } from "@codexhost/harness-adapter";
import { WORKSPACE_CONTRACT_VERSION } from "@codexhost/shared-contracts";

export { ClaudeCodeAdapter } from "./claude-code-adapter.js";
export type { ClaudeCodeAdapterOptions } from "./claude-code-adapter.js";
export { ClaudeCodeExecutableError, resolveClaudeCodeExecutable } from "./command.js";
export { ClaudeNativeTurnAccumulator } from "./native-message.js";
export type {
  ClaudeAdapterDependencies,
  ClaudeInteractionResponse,
  ClaudeQuestion,
  ClaudeQuestionOption,
  ClaudeQuestionRequest,
  ClaudeTransportFactoryInput,
  ClaudeTransportFailureKind,
  ClaudeTransportTurnResult,
  ClaudeTurnEvent,
  ClaudeTurnTransport,
} from "./transport.js";

export const packageMetadata = {
  name: "@codexhost/adapter-claude-code",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
  adapterContract: harnessAdapter.name,
} as const;
