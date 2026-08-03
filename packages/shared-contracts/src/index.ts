import { z } from "zod";
import { WORKSPACE_CONTRACT_VERSION } from "./version.js";

export { codexhostErrorSchema } from "./errors.js";
export type { CodexhostError } from "./errors.js";
export {
  externalThreadForkParamsSchema,
  externalThreadForkResultSchema,
} from "./external-thread-fork.js";
export type { ExternalThreadForkParams, ExternalThreadForkResult } from "./external-thread-fork.js";
export {
  HARNESS_PERMISSION_MODE_CATALOG_MAX_LENGTH,
  HARNESS_PERMISSION_MODE_DESCRIPTION_MAX_LENGTH,
  HARNESS_PERMISSION_MODE_ID_MAX_LENGTH,
  HARNESS_PERMISSION_MODE_LABEL_MAX_LENGTH,
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
  harnessPermissionModeSchema,
  threadPermissionModeSelectParamsSchema,
} from "./harness-permission-modes.js";
export type {
  HarnessPermissionMode,
  HarnessPermissionModeCatalog,
  HarnessPermissionModeId,
  ThreadPermissionModeSelectParams,
} from "./harness-permission-modes.js";
export {
  HARNESS_MODEL_LABEL_MAX_LENGTH,
  HARNESS_MODEL_REF_MAX_LENGTH,
  HARNESS_THINKING_OPTION_ID_MAX_LENGTH,
  THREAD_OWNERSHIP_LIST_MAX_LENGTH,
  harnessConfigurationStateSchema,
  harnessInspectParamsSchema,
  harnessInspectionSchema,
  harnessModelCatalogSchema,
  harnessModelRefIdSchema,
  harnessModelRefSchema,
  harnessModelSchema,
  harnessModelSelectionStateSchema,
  harnessResolvedModelLabelSchema,
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
  HarnessConfigurationState,
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
