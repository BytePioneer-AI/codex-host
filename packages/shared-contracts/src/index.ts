import { z } from "zod";
import { WORKSPACE_CONTRACT_VERSION } from "./version.js";

export { codexhostErrorSchema } from "./errors.js";
export type { CodexhostError } from "./errors.js";
export {
  HARNESS_MODEL_REF_MAX_LENGTH,
  HARNESS_THINKING_OPTION_ID_MAX_LENGTH,
  THREAD_OWNERSHIP_LIST_MAX_LENGTH,
  harnessInspectParamsSchema,
  harnessInspectionSchema,
  harnessModelCatalogSchema,
  harnessModelRefIdSchema,
  harnessModelRefSchema,
  harnessModelSchema,
  harnessModelSelectionStateSchema,
  harnessSessionCapabilitiesSchema,
  harnessThinkingOptionIdSchema,
  harnessThinkingOptionSchema,
  threadInspectionParamsSchema,
  threadInspectionSchema,
  threadModelSelectParamsSchema,
  threadThinkingSelectParamsSchema,
  threadOwnershipListParamsSchema,
  threadOwnershipListResultSchema,
  threadOwnershipSchema,
} from "./harness-models.js";
export type {
  HarnessInspectParams,
  HarnessInspection,
  HarnessModel,
  HarnessModelCatalog,
  HarnessModelRef,
  HarnessModelSelectionState,
  HarnessSessionCapabilities,
  HarnessThinkingOption,
  HarnessThinkingOptionId,
  ThreadInspection,
  ThreadInspectionParams,
  ThreadModelSelectParams,
  ThreadThinkingSelectParams,
  ThreadOwnership,
  ThreadOwnershipListParams,
  ThreadOwnershipListResult,
} from "./harness-models.js";
export {
  harnessIdSchema,
  hostInteractionIdSchema,
  hostItemIdSchema,
  hostThreadIdSchema,
  hostTurnIdSchema,
} from "./ids.js";
export type { HarnessId, HostInteractionId, HostItemId, HostThreadId, HostTurnId } from "./ids.js";
export {
  jsonRpcEnvelopeSchema,
  jsonRpcErrorResponseSchema,
  jsonRpcErrorSchema,
  jsonRpcIdSchema,
  jsonRpcNotificationSchema,
  jsonRpcRequestSchema,
  jsonRpcSuccessResponseSchema,
} from "./json-rpc.js";
export type {
  JsonRpcEnvelope,
  JsonRpcError,
  JsonRpcErrorResponse,
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcSuccessResponse,
} from "./json-rpc.js";
export {
  jsonArraySchema,
  jsonObjectSchema,
  jsonPrimitiveSchema,
  jsonValueSchema,
} from "./json-value.js";
export type { JsonArray, JsonObject, JsonPrimitive, JsonValue } from "./json-value.js";
export {
  nativeCheckpointRefSchema,
  nativeCheckpointRefV1Schema,
  nativeSessionRefSchema,
  nativeSessionRefV1Schema,
  nativeTurnRefSchema,
  nativeTurnRefV1Schema,
} from "./native-refs.js";
export type {
  NativeCheckpointRef,
  NativeCheckpointRefV1,
  NativeSessionRef,
  NativeSessionRefV1,
  NativeTurnRef,
  NativeTurnRefV1,
} from "./native-refs.js";
export { WORKSPACE_CONTRACT_VERSION } from "./version.js";

export const workspaceContractVersionSchema = z.literal(WORKSPACE_CONTRACT_VERSION);

export const packageMetadata = {
  name: "@codexhost/shared-contracts",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
} as const;
