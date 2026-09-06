import { WORKSPACE_CONTRACT_VERSION } from "@codexhost/shared-contracts";

export { KiroAdapter, KiroSession, KIRO_SESSION_CAPABILITIES } from "./kiro-adapter.js";
export type {
  KiroAdapterDependencies,
  KiroAdapterOptions,
  KiroAcpTransportLike,
} from "./kiro-adapter.js";

export {
  KiroAcpTransport,
  KiroTransportError,
} from "./acp-transport.js";
export type {
  KiroAcpTransportOptions,
  KiroForkOpenInput,
  KiroRollbackOpenInput,
  KiroOpenInput,
  KiroOpenResult,
  KiroTransportEvent,
  KiroTransportFaultKind,
} from "./acp-transport.js";

export {
  KiroExecutableError,
  kiroDiscoverySpec,
  kiroInvocation,
  resolveKiroExecutable,
} from "./command.js";

export {
  KIRO_DEFAULT_MODEL_CATALOG,
  KIRO_DEFAULT_MODELS,
  parseKiroModelCatalog,
} from "./models.js";
export type { KiroModelState } from "./models.js";

export {
  KIRO_DEFAULT_PERMISSION_MODE_ID,
  KIRO_PERMISSION_MODES,
  KIRO_PERMISSION_MODE_CATALOG,
  decodeKiroPermissionMode,
  encodeKiroPermissionMode,
} from "./permission-modes.js";

export { KIRO_COMMANDS, KIRO_COMMAND_CATALOG } from "./commands.js";

export { projectKiroFileChanges, DEFAULT_KIRO_FILE_CHANGE_TEXT_LIMIT } from "./file-diff.js";

export {
  projectKiroPermission,
  projectKiroToolCall,
  projectKiroUserInput,
} from "./projection.js";
export type {
  KiroUserInputParams,
  KiroUserInputResult,
  ProjectedApproval,
  ProjectedQuestion,
  ProjectedToolItem,
} from "./projection.js";

export {
  findForkBoundary,
  findRollbackBoundary,
  kiroHomeDir,
  locateKiroNativeSession,
  parseKiroHistory,
  readKiroNativeMessages,
  readKiroSnapshot,
} from "./history.js";
export type {
  KiroHistoryRow,
  KiroHistorySummary,
  KiroNativeSessionLocation,
  KiroSessionMeta,
  KiroTurnBoundary,
} from "./history.js";

export const packageMetadata = {
  name: "@codexhost/adapter-kiro-cli",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
} as const;
