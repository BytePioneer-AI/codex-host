import { packageMetadata as harnessAdapter } from "@codexhost/harness-adapter";
import { packageMetadata as mappingStore } from "@codexhost/mapping-store";
import { WORKSPACE_CONTRACT_VERSION } from "@codexhost/shared-contracts";

export { jsonRpcRequestSchema, jsonRpcSuccessResponseSchema } from "@codexhost/shared-contracts";
export type { JsonObject, JsonRpcId, JsonRpcRequest, JsonValue } from "@codexhost/shared-contracts";
export { CodexTurnProjector } from "./codex-ui-projector.js";
export type { CodexTurnProjection, ProjectableHostEvent } from "./codex-ui-projector.js";
export {
  PI_NATIVE_TRANSPORT_MODEL_ID,
  PI_NATIVE_TRANSPORT_MODEL_PREFIX,
  decodeCreateRoute,
  decodePiTransportModel,
  encodePiTransportModel,
} from "./model-routing.js";
export type { CreateRoute } from "./model-routing.js";
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
