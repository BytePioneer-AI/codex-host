import { packageMetadata as harnessAdapter } from "@codexhost/harness-adapter";
import { packageMetadata as mappingStore } from "@codexhost/mapping-store";
import { WORKSPACE_CONTRACT_VERSION } from "@codexhost/shared-contracts";

export { jsonRpcRequestSchema, jsonRpcSuccessResponseSchema } from "@codexhost/shared-contracts";
export type { JsonObject, JsonRpcId, JsonRpcRequest, JsonValue } from "@codexhost/shared-contracts";
export { projectCodexApprovalRequest } from "./codex-approval.js";
export type { CodexApprovalRequestProjection } from "./codex-approval.js";
export { projectCodexQuestionRequest } from "./codex-question.js";
export type { CodexQuestionRequestProjection } from "./codex-question.js";
export { projectCodexThreadUsage } from "./codex-usage.js";
export type { CodexThreadUsageProjectionInput } from "./codex-usage.js";
export {
  observeCodexRateLimits,
  observeCodexTokenUsage,
  projectCodexRateLimitsToCredits,
} from "./codex-native-usage.js";
export { CodexTurnProjector, projectHistoricalTurn } from "./codex-ui-projector.js";
export type {
  CodexApprovalProjection,
  CodexQuestionProjection,
  CodexTurnProjection,
  HistoricalTurnProjectionInput,
  ProjectableHostEvent,
} from "./codex-ui-projector.js";
export {
  decodeThreadForkRequest,
  decodeThreadRevertRequest,
  decodeThreadRollbackRequest,
  mapExternalThreadHarnessError,
  threadForkResult,
  threadRevertResult,
  threadRollbackResult,
} from "./thread-fork.js";
export type {
  DecodedThreadForkRequest,
  DecodedThreadRevertRequest,
  DecodedThreadRollbackRequest,
  ExternalThreadRpcError,
} from "./thread-fork.js";
export {
  decodeHostThreadListCursor,
  decodeOfficialThreadListPage,
  decodeThreadArchiveRequest,
  decodeThreadListRequest,
  decodeThreadMetadataUpdateRequest,
  encodeHostThreadListCursor,
} from "./thread-management.js";
export type {
  DecodedThreadListRequest,
  DecodedThreadManagementRequest,
  DecodedThreadMetadataUpdateRequest,
  HostThreadListCursor,
  OfficialThreadListPage,
  ThreadListExternalAnchor,
  ThreadListSortDirection,
  ThreadListSortKey,
} from "./thread-management.js";
export {
  CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID,
  CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_PREFIX,
  DEEPSEEK_HARNESS_NATIVE_TRANSPORT_MODEL_ID,
  DEEPSEEK_HARNESS_NATIVE_TRANSPORT_MODEL_PREFIX,
  EXTERNAL_HARNESS_IDS,
  GROK_NATIVE_TRANSPORT_MODEL_ID,
  GROK_NATIVE_TRANSPORT_MODEL_PREFIX,
  GEMINI_NATIVE_TRANSPORT_MODEL_ID,
  GEMINI_NATIVE_TRANSPORT_MODEL_PREFIX,
  OMP_NATIVE_TRANSPORT_MODEL_ID,
  OMP_NATIVE_TRANSPORT_MODEL_PREFIX,
  PI_NATIVE_TRANSPORT_MODEL_ID,
  PI_NATIVE_TRANSPORT_MODEL_PREFIX,
  decodeClaudeTransportSelection,
  decodeCreateRoute,
  decodeDeepSeekHarnessTransportSelection,
  decodeExternalTransportModel,
  decodeExternalTransportSelection,
  decodeGrokTransportSelection,
  decodeGeminiTransportSelection,
  decodeOmpTransportSelection,
  decodePiTransportModel,
  decodePiTransportSelection,
  encodeClaudeTransportModel,
  encodeDeepSeekHarnessTransportModel,
  encodeExternalTransportSelection,
  encodeGrokTransportModel,
  encodeGeminiTransportModel,
  encodeOmpTransportModel,
  encodePiTransportModel,
  transportModelIdForHarness,
} from "./model-routing.js";
export type {
  CreateRoute,
  ExternalConfigurationSelection,
  ExternalHarnessId,
  RoutedHarnessId,
} from "./model-routing.js";
export {
  encodeJsonFrame,
  parseJsonFrame,
  readLfFrames,
  writeFrame,
  writeJsonFrame,
} from "./jsonl.js";

export const packageMetadata = {
  name: "@codexhost/protocol-core",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
  dependencies: [harnessAdapter.name, mappingStore.name],
} as const;
