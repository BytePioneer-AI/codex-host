import type { ThreadExportInput, ThreadExportResult } from "./delegation-thread-export.js";
import type { DelegationWorktree } from "./delegation-worktree.js";
import type { JsonObject, JsonValue, RoutedHarnessId } from "@codexhost/protocol-core";
import type { PeerDelegationHostsResult } from "@codexhost/shared-contracts";
import type {
  HarnessInspection,
  HarnessModelRef,
  HarnessSessionState,
  HarnessThinkingOptionId,
} from "@codexhost/harness-adapter";

export const DELEGATION_RUNTIME_ENDPOINT_ENV = "CODEXHOST_RUNTIME_ENDPOINT";
export const DELEGATION_RUNTIME_TOKEN_ENV = "CODEXHOST_RUNTIME_TOKEN";
export const DELEGATION_CLI_PATH_ENV = "CODEXHOST_CLI_PATH";
/** Node for the Launcher's delegation CLI in npm installations; read only by the Launcher. */
export const DELEGATION_CLI_NODE_PATH_ENV = "CODEXHOST_CLI_NODE_PATH";
export const DELEGATION_THREAD_ID_ENV = "CODEXHOST_THREAD_ID";
/** An external client token from `codexhost client add`, used when no Host connection is provided. */
export const EXTERNAL_CLIENT_TOKEN_ENV = "CODEXHOST_CLIENT_TOKEN";
export const EXTERNAL_CLIENT_TOKEN_FILE_ENV = "CODEXHOST_CLIENT_TOKEN_FILE";
/** Port of the external client listener; `off` disables it. */
export const EXTERNAL_CLIENT_PORT_ENV = "CODEXHOST_EXTERNAL_CLIENT_PORT";
/**
 * Native Codex shares one app-server across Threads, so the Host cannot set
 * CODEXHOST_THREAD_ID per Thread; Codex exports the calling Thread here instead.
 */
export const NATIVE_CODEX_THREAD_ID_ENV = "CODEX_THREAD_ID";
/** Default watch expiry; callers adjust it with --timeout-ms. */
export const DEFAULT_WATCH_TIMEOUT_MS = 29 * 60_000;
/** Default `thread wait` budget; callers adjust it with --timeout-ms. */
export const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
/** Default `thread list` page size and ordering. */
export const DEFAULT_LIST_LIMIT = 25;
export const DEFAULT_LIST_SORT = "created-desc";

export type DelegationCallerAuthContext =
  | { readonly kind: "external-client"; readonly client: string }
  | { readonly kind: "agent"; readonly boundThreadId?: string };

/**
 * Private side-table attaching Host-verified caller auth context to an input object without
 * mutating its keys or shape. JSON HTTP payloads can never populate this WeakMap.
 */
const callerAuthContexts = new WeakMap<object, DelegationCallerAuthContext>();

export function attachCallerAuthContext<T extends object>(
  value: T,
  context: DelegationCallerAuthContext | undefined,
): T {
  if (context) callerAuthContexts.set(value, context);
  return value;
}

export function getCallerAuthContext(
  value: object | undefined,
): DelegationCallerAuthContext | undefined {
  return value ? callerAuthContexts.get(value) : undefined;
}

export interface PersistedDelegationLookup {
  delegationId: string;
  parentHostThreadId: string;
  childHostThreadId: string;
  targetHarnessId: RoutedHarnessId;
  status: DelegationThreadStatus;
  taskDigest: string;
  cwd?: string;
  title?: string;
}

export type DelegationThreadStatus =
  "creating" | "running" | "completed" | "failed" | "interrupted";

export type DelegationResultAvailability = "pending" | "available" | "unavailable";

export interface DelegationMessage {
  id: string;
  role: "user" | "agent";
  text: string;
  phase?: "final";
}

export interface DelegationMessageTurn {
  turnId: string | null;
  turnNumber: number;
  status: DelegationThreadStatus;
  messages: DelegationMessage[];
}

export interface DelegationProgress {
  id: string;
  turnId: string;
  text: string;
}

/**
 * One Question request the Host is waiting to answer. It is reported by
 * `thread read`, so a caller can answer it without registering a watch, and it
 * uses the same Question contract the Harness Adapter reported.
 */
export interface DelegationPendingQuestion {
  /** Opaque Host request identity accepted by `thread answer --interaction`, not an Adapter ID. */
  interactionId: string;
  kind: "requestUserInput" | "requestUserInputAsync";
  /** Turn that asked the question; asynchronous questions do not pause it. */
  turnId: string;
  expiresAt?: string;
  /** Original request params, or one native async question with its source identity. */
  request: JsonObject;
}

export interface DelegationThreadSnapshot {
  hostId?: string;
  threadId: string;
  harnessId: RoutedHarnessId;
  cwd?: string;
  title?: string;
  status: DelegationThreadStatus;
  turn: { turnId: string; status: DelegationThreadStatus } | null;
  progress: DelegationProgress[];
  result: {
    availability: DelegationResultAvailability;
    text?: string;
    message?: string;
  };
  turns?: DelegationMessageTurn[];
  totalTurns?: number;
  /** Inclusive absolute Turn numbers; null when the range contains no Turns. */
  from?: number | null;
  to?: number | null;
  /** Omitted when the Thread carries no references. */
  refs?: string[];
  /** Empty when the Thread has no unanswered questions. */
  pendingQuestions?: DelegationPendingQuestion[];
}

export interface DelegationStartInput {
  /** Internal caller context for hop checks; not forwarded to remote Hosts. */
  callerThreadId?: string;
  /** Target Host identity (e.g. `remote-peer:<peerId>`); omit or `"local"` for this Host. */
  hostId?: string;
  harnessId: RoutedHarnessId;
  task: string;
  /** Short display name; the full task remains the initial message. */
  taskName?: string;
  cwd?: string;
  /** New Git branch prepared on the execution Host (forwarded to B for remote peer starts). */
  worktree?: string;
  /** Base Git ref for `worktree` (forwarded to B for remote peer starts). */
  base?: string;
  parentThreadId?: string;
  requestId?: string;
  model?: HarnessModelRef | string;
  officialModelArgument?: string;
  thinkingOptionId?: HarnessThinkingOptionId;
  /** Absolute URIs of where the work came from; children inherit them. */
  refs?: string[];
}

export interface HarnessInspectInput {
  callerThreadId?: string;
  hostId?: string;
  harnessId: RoutedHarnessId;
  cwd?: string;
  refresh?: boolean;
  credentialAccess?: "allow" | "retry";
  /** Calling Thread; an official parent cannot inspect a Harness Desktop must not present. */
  parentThreadId?: string;
}

export interface HarnessListInput {
  callerThreadId?: string;
  hostId?: string;
  /** Calling Thread; an official parent cannot list a Harness Desktop must not present. */
  parentThreadId?: string;
}

export interface HarnessInspectResult {
  hostId?: string;
  harnessId: RoutedHarnessId;
  inspection: HarnessInspection;
}

export interface HarnessListResult {
  hostId?: string;
  harnesses: RoutedHarnessId[];
}

export interface DelegationConfigurationResult {
  requested?: { model?: HarnessModelRef; thinkingOptionId?: HarnessThinkingOptionId };
  effective?: Pick<
    HarnessSessionState,
    "effectiveModel" | "resolvedModelLabel" | "effectiveThinkingOptionId"
  >;
}

export interface DelegationStartResult {
  hostId?: string;
  delegationId: string;
  threadId: string;
  turnId: string;
  harnessId: RoutedHarnessId;
  deepLink: string;
  status: DelegationThreadStatus;
  cwd?: string;
  title?: string;
  parentThreadId?: string;
  configuration?: DelegationConfigurationResult;
  /** References the child carries, inherited ones first; omitted when there are none. */
  refs?: string[];
  /** Present only when the caller asked `delegate start` to also watch the child. */
  watch?: ThreadWatchResult | { state: "notRegistered"; reason: string };
  /** Present when start prepared an isolated Git checkout. */
  worktree?: DelegationWorktree;
  next: { read: string; wait: string };
}

export interface ThreadSendInput {
  callerThreadId?: string;
  hostId?: string;
  threadId: string;
  message: string;
  /** Stop the current Turn and confirm idle before sending; preserve existing watches. */
  interrupt?: boolean;
  /** Use the existing steering operation when running; idle Threads start a Turn. */
  steer?: boolean;
}

export interface ThreadSendResult {
  hostId?: string;
  threadId: string;
  turnId: string;
  harnessId: RoutedHarnessId;
  status: "running";
  /** Present only when send also requested a watch, in the same shape as delegate start. */
  watch?: DelegationStartResult["watch"];
  next: { read: string; wait: string };
}

export interface ThreadCancelInput {
  callerThreadId?: string;
  hostId?: string;
  threadId: string;
}

export interface ThreadCancelResult {
  hostId?: string;
  threadId: string;
  turnId: string | null;
  harnessId: RoutedHarnessId;
  cancelled: boolean;
}

export interface ThreadReadInput {
  /** Internal caller context from the CLI; not forwarded to another Host. */
  callerThreadId?: string;
  /** Explicit Desktop Host identity; never inferred from the Thread ID. */
  hostId?: string;
  threadId: string;
  view: "result" | "messages";
  from?: number;
  to?: number;
}

export interface ThreadWaitInput extends ThreadReadInput {
  timeoutMs: number;
}

export interface ThreadAnswerInput {
  callerThreadId?: string;
  hostId?: string;
  threadId: string;
  /** Interaction ID reported by `thread read` in `pendingQuestions`. */
  interactionId: string;
  /** Existing requestUserInput result, or { answer: string } for a native async question. */
  result: JsonValue;
}

export interface ThreadAnswerResult {
  hostId?: string;
  threadId: string;
  interactionId: string;
  turnId: string;
  harnessId: RoutedHarnessId;
  /** Reply submission receipt; read the Thread for its actual execution state. */
  status: "running";
  next: { read: string; wait: string };
}

export interface ThreadListInput {
  callerThreadId?: string;
  hostId?: string;
  cwd?: string;
  parentThreadId?: string;
  /** Threads an external client started without a parent Thread. */
  client?: string;
  /** Threads that carry this reference. */
  ref?: string;
  limit: number;
  cursor?: string;
  sort:
    | "created-asc"
    | "created-desc"
    | "updated-asc"
    | "updated-desc"
    | "recency-asc"
    | "recency-desc";
}

export interface DelegationThreadListItem {
  hostId?: string;
  threadId: string;
  harnessId: RoutedHarnessId;
  deepLink: string;
  status: DelegationThreadStatus;
  cwd?: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  /** Set by native rows; recency-* sorts order by it, falling back to updatedAt. */
  recencyAt?: string;
  refs?: string[];
}

export interface DelegationThreadListResult {
  hostId?: string;
  threads: DelegationThreadListItem[];
  nextCursor: string | null;
}

export interface ThreadWatchInput {
  hostId?: string;
  /** Thread observed until it stops. */
  threadId: string;
  /** Thread that receives the single notification. */
  notifyThreadId: string;
  timeoutMs: number;
}

export type ThreadWatchOutcome =
  | "completed"
  | "failed"
  | "interrupted"
  /** The Thread is running but waiting for an answer. */
  | "needsInput"
  /** The Thread was still running when the watch expired. */
  | "timedOut"
  /** Reads kept failing, so the state of the Thread is unknown. */
  | "unreadable"
  | "notFound";

export interface ThreadWatchResult {
  threadId: string;
  notifyThreadId: string;
  /**
   * `alreadyTerminal` and `alreadyNeedsInput` mean no watch was registered and
   * no notification will be sent.
   */
  state: "watching" | "alreadyTerminal" | "alreadyNeedsInput";
  status: DelegationThreadStatus;
  timeoutMs: number;
  /** Present for `alreadyNeedsInput`, so the caller can answer without re-reading. */
  pendingQuestions?: DelegationPendingQuestion[];
}

export interface ThreadWatchEntry {
  threadId: string;
  notifyThreadId: string;
  state: "watching" | "pendingDelivery" | "undeliverable";
  outcome?: ThreadWatchOutcome;
  /** Turn that reached the reported outcome, when the Thread reported one. */
  turnId?: string;
  /** Question request that reported `needsInput`. */
  interactionId?: string;
  /** Present for `undeliverable`. */
  reason?: string;
  registeredAt: string;
  /** Current title, or the last observed title when the Thread cannot be read. */
  taskName?: string;
  /** Current Thread status; omitted when the Thread cannot be read. */
  threadStatus?: DelegationThreadStatus;
  /** Elapsed time since registration, including Host downtime. */
  watchedForMs?: number;
}

export interface ThreadWatchListResult {
  watches: ThreadWatchEntry[];
}

/**
 * Opt-in, one-shot notifications when a watched Thread stops. Separate from
 * DelegationControlApi so Host sessions keep implementing only the per-Thread
 * operations.
 */
export interface DelegationWatchApi {
  watch(input: ThreadWatchInput): Promise<ThreadWatchResult>;
  watches(): Promise<ThreadWatchListResult>;
}

export interface DelegationControlApi {
  listHosts?(): Promise<PeerDelegationHostsResult>;
  listHarnesses(input?: HarnessListInput): Promise<HarnessListResult>;
  inspect(input: HarnessInspectInput): Promise<HarnessInspectResult>;
  start(input: DelegationStartInput): Promise<DelegationStartResult>;
  send(input: ThreadSendInput): Promise<ThreadSendResult>;
  cancel(input: ThreadCancelInput): Promise<ThreadCancelResult>;
  read(input: ThreadReadInput): Promise<DelegationThreadSnapshot>;
  /** Optional for older control registrations that do not support debug exports. */
  exportThread?(input: ThreadExportInput): Promise<ThreadExportResult>;
  wait(input: ThreadWaitInput): Promise<DelegationThreadSnapshot & { timedOut: boolean }>;
  answer(input: ThreadAnswerInput): Promise<ThreadAnswerResult>;
  list(input: ThreadListInput): Promise<DelegationThreadListResult>;
}

export interface DelegationControlRegistration extends DelegationControlApi {
  executionHostId?(threadId: string): string | undefined;
  delegationParent?(threadId: string): Promise<string | undefined>;
  /** Active native Codex Thread IDs eligible to authenticate with the shared Runtime token. */
  activeNativeThreadIds?(): string[] | Promise<string[]>;
  findDelegationByRequest?(requestId: string): Promise<PersistedDelegationLookup | null>;
  onThreadIdle?(listener: (threadId: string) => void): () => void;
  canHandleStart(input: DelegationStartInput): boolean | Promise<boolean>;
  ownsThread(threadId: string): boolean | Promise<boolean>;
}

export type DelegationControlErrorCode =
  | "INVALID_ARGUMENT"
  | "HARNESS_NOT_FOUND"
  | "THREAD_NOT_FOUND"
  | "THREAD_BUSY"
  | "PARENT_THREAD_AMBIGUOUS"
  | "RESPONSE_TOO_LARGE"
  | "RUNTIME_UNREACHABLE"
  | "DELEGATION_FAILED"
  /** The client lacks the scope, or a result file is outside the Thread's exportable files. */
  | "FORBIDDEN"
  /** The operation requires a known local execution workspace. */
  | "UNSUPPORTED"
  /** The external client token is missing, unknown, or revoked. */
  | "UNAUTHORIZED"
  /** The event cursor is older than the oldest retained event. */
  | "CURSOR_EXPIRED"
  /** The Question request is unknown, already answered, or no longer pending. */
  | "QUESTION_NOT_PENDING"
  | "INTERNAL_ERROR";

export class DelegationControlError extends Error {
  constructor(
    readonly code: DelegationControlErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DelegationControlError";
  }
}
