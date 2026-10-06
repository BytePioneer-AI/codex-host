import { WORKSPACE_CONTRACT_VERSION } from "@codexhost/shared-contracts";

export { MappingStore, MappingStoreError } from "./mapping-store.js";
export type { MappingStoreErrorCode, MappingStoreOptions } from "./mapping-store.js";
export {
  delegationStatusSchema,
  storedDelegationRecordV1Schema,
  storedThreadCoreV1Schema,
  storedThreadMetadataV1Schema,
  storedThreadRecordV1Schema,
  storedTurnMappingV1Schema,
} from "./records.js";
export type {
  CommitReadyThreadInput,
  CreateDelegationInput,
  CreateProvisionalThreadInput,
  DelegationStatus,
  FindRecentDelegationInput,
  RebindSubagentSessionInput,
  ReplaceReadySessionAfterLastTurnInput,
  ReplaceReadySessionInput,
  StoredDelegationRecordV1,
  StoredThreadMetadataV1,
  StoredThreadRecordV1,
  StoredTurnMappingV1,
  ThreadMetadataPatch,
} from "./records.js";
export { storedSectionPlacementV1Schema } from "./section-placements.js";
export { SUPERSEDED_SESSIONS_MAX } from "./superseded-sessions.js";
export type { StoredSupersededSessionV1 } from "./superseded-sessions.js";
export type { StoredSectionPlacementV1, StoredThreadSection } from "./section-placements.js";

export const packageMetadata = {
  name: "@codexhost/mapping-store",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
} as const;
