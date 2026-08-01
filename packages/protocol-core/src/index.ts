import { packageMetadata as harnessAdapter } from "@codexhost/harness-adapter";
import { packageMetadata as mappingStore } from "@codexhost/mapping-store";
import { WORKSPACE_CONTRACT_VERSION } from "@codexhost/shared-contracts";

export { jsonRpcRequestSchema, jsonRpcSuccessResponseSchema } from "@codexhost/shared-contracts";
export type { JsonObject, JsonRpcId, JsonRpcRequest, JsonValue } from "@codexhost/shared-contracts";
export { projectCodexQuestionRequest } from "./codex-question.js";
export type { CodexQuestionRequestProjection } from "./codex-question.js";
export { projectCodexThreadUsage } from "./codex-usage.js";
export type { CodexThreadUsageProjectionInput } from "./codex-usage.js";
export { CodexTurnProjector, projectHistoricalTurn } from "./codex-ui-projector.js";
export type {
  CodexQuestionProjection,
  CodexTurnProjection,
  HistoricalTurnProjectionInput,
  ProjectableHostEvent,
} from "./codex-ui-projector.js";
export {
  decodeThreadForkRequest,
  decodeThreadRollbackRequest,
  mapExternalThreadHarnessError,
  threadForkResult,
  threadRollbackResult,
} from "./thread-fork.js";
export type {
  DecodedThreadForkRequest,
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
  EXTERNAL_HARNESS_IDS,
  PI_NATIVE_TRANSPORT_MODEL_ID,
  PI_NATIVE_TRANSPORT_MODEL_PREFIX,
  decodeClaudeTransportSelection,
  decodeCreateRoute,
  decodeExternalTransportModel,
  decodeExternalTransportSelection,
  decodePiTransportModel,
  decodePiTransportSelection,
  encodeClaudeTransportModel,
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
