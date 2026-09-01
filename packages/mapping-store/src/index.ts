import { WORKSPACE_CONTRACT_VERSION } from "@codexhost/shared-contracts";

export { MappingStore, MappingStoreError } from "./mapping-store.js";
export type { MappingStoreErrorCode, MappingStoreOptions } from "./mapping-store.js";
export {
  delegationStatusSchema,
  delegationExecutionPolicySchema,
  storedDelegationRecordV1Schema,
  storedThreadRecordV1Schema,
  storedTurnMappingV1Schema,
} from "./records.js";
export type {
  CommitReadyThreadInput,
  CreateDelegationInput,
  CreateProvisionalThreadInput,
  DelegationStatus,
  DelegationExecutionPolicy,
  FindRecentDelegationInput,
  ReplaceReadySessionAfterLastTurnInput,
  ReplaceReadySessionInput,
  StoredDelegationRecordV1,
  StoredThreadRecordV1,
  StoredTurnMappingV1,
} from "./records.js";

export const packageMetadata = {
  name: "@codexhost/mapping-store",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
} as const;
