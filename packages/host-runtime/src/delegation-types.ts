import type { JsonObject, RoutedHarnessId } from "@codexhost/protocol-core";
import type {
  HarnessInspection,
  HarnessModelRef,
  HarnessSessionState,
  HarnessThinkingOptionId,
} from "@codexhost/harness-adapter";
import type { DelegationCapacitySettings } from "@codexhost/shared-contracts";

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

/** `queued`: waiting for the local capacity limit; the Thread does not exist yet. */
export type DelegationThreadStatus =
  "queued" | "creating" | "running" | "completed" | "failed" | "interrupted";

/** 1-based place among the queued starts; present only while queued. */
export interface DelegationQueuePlace {
  position: number;
}

export type DelegationResultAvailability = "pending" | "available" | "unavailable";

export interface DelegationMessage {
  id: string;
  turnId: string;
  role: "user" | "agent";
  text: string;
  phase?: "commentary" | "final";
}

export interface DelegationProgress {
  id: string;
  turnId: string;
  text: string;
}

export interface DelegationThreadSnapshot {
  hostId?: string;
  threadId: string;
  harnessId: RoutedHarnessId;
  title?: string;
  status: DelegationThreadStatus;
  turn: { turnId: string; status: DelegationThreadStatus } | null;
  progress: DelegationProgress[];
  result: {
    availability: DelegationResultAvailability;
    text?: string;
    message?: string;
  };
  messages?: DelegationMessage[];
  hasMore?: boolean;
  nextCursor: string | null;
  /** Omitted when the Thread carries no references. */
  refs?: string[];
  queue?: DelegationQueuePlace;
}

export interface DelegationStartInput {
  harnessId: RoutedHarnessId;
  task: string;
  /** Short display name; the full task remains the initial message. */
  taskName?: string;
  cwd?: string;
  parentThreadId?: string;
  requestId?: string;
  model?: HarnessModelRef;
  thinkingOptionId?: HarnessThinkingOptionId;
  /** Absolute URIs of where the work came from; children inherit them. */
  refs?: string[];
}

export interface HarnessInspectInput {
  harnessId: RoutedHarnessId;
  cwd?: string;
  refresh?: boolean;
  /** Calling Thread; an official parent cannot inspect a Harness Desktop must not present. */
  parentThreadId?: string;
}

export interface HarnessListInput {
  /** Calling Thread; an official parent cannot list a Harness Desktop must not present. */
  parentThreadId?: string;
}

export interface HarnessInspectResult {
  harnessId: RoutedHarnessId;
  inspection: HarnessInspection;
}

export interface HarnessListResult {
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
  queue?: DelegationQueuePlace;
  next: { read: string; wait: string };
}

/** Identifiers a queued start keeps until its Thread is created. */
export interface DelegationStartIdentity {
  delegationId: string;
  threadId: string;
  turnId: string;
}

/** A validated start with its parent and workspace resolved, offered to the capacity limit. */
export interface DelegationAdmissionRequest {
  input: DelegationStartInput & { parentThreadId: string; cwd: string };
  title: string;
  taskDigest: string;
  identity: DelegationStartIdentity;
  /**
   * Creates the Thread a queued start waits in, when its identity comes from the
   * Harness; called only once the start must queue, and its identity replaces `identity`.
   */
  prepare?(): Promise<DelegationStartIdentity>;
}

/** A start waiting in the queue, with what its session needs to start or adopt it. */
export interface DelegationQueuedStart {
  identity: DelegationStartIdentity;
  input: DelegationStartInput & { parentThreadId: string; cwd: string };
  taskDigest: string;
}

/**
 * A queued start a user message is taking over. It stays in its place, and is
 * neither started nor cancelled, until the message's Turn start settles.
 */
export interface DelegationQueueClaim extends DelegationQueuedStart {
  /**
   * `started` removes it from the queue; `rejected` puts it back as it was;
   * `unknown` puts it back to be checked for a Turn before anything else happens to it.
   */
  settle(outcome: "started" | "rejected" | "unknown"): Promise<void>;
}

export type DelegationAdmission =
  /** Start now; release once the start has settled. */
  | { state: "admitted"; release(): void }
  /** Waiting or starting under this identity, possibly queued by an earlier identical request. */
  | {
      state: "queued";
      identity: DelegationStartIdentity;
      status: "queued" | "creating";
      position?: number;
      parentThreadId: string;
      cwd: string;
      title: string;
    };

export interface DelegationCapacityGate {
  admit(request: DelegationAdmissionRequest): Promise<DelegationAdmission>;
  configure(settings: DelegationCapacitySettings): DelegationCapacitySettings;
  /** Holds a waiting start of this Harness for its session to start now; undefined when none waits. */
  claim(threadId: string, harnessId: string): Promise<DelegationQueueClaim | undefined>;
  peek?(
    threadId: string,
  ): Promise<{ status: "queued" | "creating"; position?: number } | undefined>;
  finished?(input: ThreadReadInput): Promise<DelegationThreadSnapshot | undefined>;
  previewTurn?(threadId: string): JsonObject | undefined;
}

export interface ThreadSendInput {
  threadId: string;
  message: string;
}

export interface ThreadSendResult {
  threadId: string;
  turnId: string;
  harnessId: RoutedHarnessId;
  status: "running";
  next: { read: string; wait: string };
}

export interface ThreadCancelInput {
  threadId: string;
}

export interface ThreadCancelResult {
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
  cursor?: string;
  limit?: number;
}

export interface ThreadWaitInput extends ThreadReadInput {
  timeoutMs: number;
}

export interface ThreadListInput {
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
  queue?: DelegationQueuePlace;
}

export interface DelegationThreadListResult {
  threads: DelegationThreadListItem[];
  nextCursor: string | null;
}

export interface ThreadWatchInput {
  /** Thread observed until it stops. */
  threadId: string;
  /** Thread that receives stop/expiry and any enabled silence notifications. */
  notifyThreadId: string;
  timeoutMs: number;
  /** Optional silence threshold; omitted disables stalled notifications. */
  stallAfterMs?: number;
}

export type ThreadWatchOutcome =
  | "completed"
  | "failed"
  | "interrupted"
  /** The Thread was still running when the watch expired. */
  | "timedOut"
  /** Still running, with no observed Harness event for the configured threshold. */
  | "stalled"
  /** Reads kept failing, so the state of the Thread is unknown. */
  | "unreadable"
  | "notFound";

export interface ThreadWatchResult {
  threadId: string;
  notifyThreadId: string;
  /** `alreadyTerminal` means no watch was registered and no notification will be sent. */
  state: "watching" | "alreadyTerminal";
  status: DelegationThreadStatus;
  timeoutMs: number;
  stallAfterMs?: number;
}

export interface ThreadWatchEntry {
  threadId: string;
  notifyThreadId: string;
  state: "watching" | "pendingDelivery" | "undeliverable";
  outcome?: ThreadWatchOutcome;
  /** Turn associated with this outcome, when the Thread reported one. */
  turnId?: string;
  /** Present for `undeliverable`. */
  reason?: string;
  registeredAt: string;
  stallAfterMs?: number;
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
  listHarnesses(input?: HarnessListInput): Promise<HarnessListResult>;
  inspect(input: HarnessInspectInput): Promise<HarnessInspectResult>;
  start(input: DelegationStartInput): Promise<DelegationStartResult>;
  send(input: ThreadSendInput): Promise<ThreadSendResult>;
  cancel(input: ThreadCancelInput): Promise<ThreadCancelResult>;
  read(input: ThreadReadInput): Promise<DelegationThreadSnapshot>;
  wait(input: ThreadWaitInput): Promise<DelegationThreadSnapshot & { timedOut: boolean }>;
  list(input: ThreadListInput): Promise<DelegationThreadListResult>;
}

export interface DelegationControlRegistration extends DelegationControlApi {
  /** `admitted` starts a queued delegation under its identity, bypassing the limit and deduplication. */
  start(
    input: DelegationStartInput,
    admitted?: DelegationStartIdentity,
  ): Promise<DelegationStartResult>;
  /** Thread and Harness subagent ancestors active in an incoming Harness event. */
  subscribeActivity?(listener: (threadIds: readonly string[]) => void): () => void;
  /** Top-level Threads with an active Turn, counted against the capacity limit. */
  runningThreadIds?(): readonly string[];
  /** Receives the capacity limit of the registry this session joined. */
  useCapacity?(capacity: DelegationCapacityGate): void;
  /**
   * Whether the Thread a queued start waits in already has a Turn; one that does is
   * adopted as this start, without sending the task. Undefined when this session cannot tell.
   */
  adoptQueued?(queued: DelegationQueuedStart): Promise<boolean | undefined>;
  executionHostId?(threadId: string): string | undefined;
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
  /** The external client token is missing, unknown, or revoked. */
  | "UNAUTHORIZED"
  /** The event cursor is older than the oldest retained event. */
  | "CURSOR_EXPIRED"
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
