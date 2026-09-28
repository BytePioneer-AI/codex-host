import type { RoutedHarnessId } from "@codexhost/protocol-core";
import type {
  HarnessInspection,
  HarnessModelRef,
  HarnessSessionState,
  HarnessThinkingOptionId,
  HostQuestion,
} from "@codexhost/harness-adapter";

export const DELEGATION_RUNTIME_ENDPOINT_ENV = "CODEXHOST_RUNTIME_ENDPOINT";
export const DELEGATION_RUNTIME_TOKEN_ENV = "CODEXHOST_RUNTIME_TOKEN";
export const DELEGATION_CLI_PATH_ENV = "CODEXHOST_CLI_PATH";
/** Node for the Launcher's delegation CLI in npm installations; read only by the Launcher. */
export const DELEGATION_CLI_NODE_PATH_ENV = "CODEXHOST_CLI_NODE_PATH";
export const DELEGATION_THREAD_ID_ENV = "CODEXHOST_THREAD_ID";
/**
 * Native Codex shares one app-server across Threads, so the Host cannot set
 * CODEXHOST_THREAD_ID per Thread; Codex exports the calling Thread here instead.
 */
export const NATIVE_CODEX_THREAD_ID_ENV = "CODEX_THREAD_ID";
/** Default watch expiry; callers adjust it with --timeout-ms. */
export const DEFAULT_WATCH_TIMEOUT_MS = 29 * 60_000;

export type DelegationThreadStatus =
  "creating" | "running" | "completed" | "failed" | "interrupted";

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

/**
 * One Question request the Host is waiting to answer. It is reported by
 * `thread read`, so a caller can answer it without registering a watch, and it
 * uses the same Question contract the Harness Adapter reported.
 */
export interface DelegationPendingQuestion {
  /** Opaque Host request identity accepted by `thread answer --interaction`, not an Adapter ID. */
  interactionId: string;
  /** Turn that is waiting for this answer. */
  turnId: string;
  title?: string;
  expiresAt?: string;
  questions: HostQuestion[];
}

export interface DelegationThreadSnapshot {
  hostId?: string;
  threadId: string;
  harnessId: RoutedHarnessId;
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
  /** Empty when the Thread is not waiting for an answer. */
  pendingQuestions?: DelegationPendingQuestion[];
}

export interface DelegationStartInput {
  harnessId: RoutedHarnessId;
  task: string;
  cwd?: string;
  parentThreadId?: string;
  requestId?: string;
  model?: HarnessModelRef;
  thinkingOptionId?: HarnessThinkingOptionId;
}

export interface HarnessInspectInput {
  harnessId: RoutedHarnessId;
  cwd?: string;
  refresh?: boolean;
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
  parentThreadId?: string;
  configuration?: DelegationConfigurationResult;
  /** Present only when the caller asked `delegate start` to also watch the child. */
  watch?: ThreadWatchResult | { state: "notRegistered"; reason: string };
  next: { read: string; wait: string };
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

export interface ThreadAnswerInput {
  threadId: string;
  /** Interaction ID reported by `thread read` in `pendingQuestions`. */
  interactionId: string;
  /** Question ID to answer values, in the reported Question's value space. */
  answers: Record<string, string[]>;
}

export interface ThreadAnswerResult {
  threadId: string;
  interactionId: string;
  turnId: string;
  harnessId: RoutedHarnessId;
  /** The answered Turn keeps running; this receipt is not proof it will succeed. */
  status: "running";
  next: { read: string; wait: string };
}

export interface ThreadListInput {
  cwd?: string;
  parentThreadId?: string;
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
}

export interface DelegationThreadListResult {
  threads: DelegationThreadListItem[];
  nextCursor: string | null;
}

export interface ThreadWatchInput {
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
  listHarnesses(): Promise<HarnessListResult>;
  inspect(input: HarnessInspectInput): Promise<HarnessInspectResult>;
  start(input: DelegationStartInput): Promise<DelegationStartResult>;
  send(input: ThreadSendInput): Promise<ThreadSendResult>;
  cancel(input: ThreadCancelInput): Promise<ThreadCancelResult>;
  read(input: ThreadReadInput): Promise<DelegationThreadSnapshot>;
  wait(input: ThreadWaitInput): Promise<DelegationThreadSnapshot & { timedOut: boolean }>;
  answer(input: ThreadAnswerInput): Promise<ThreadAnswerResult>;
  list(input: ThreadListInput): Promise<DelegationThreadListResult>;
}

export interface DelegationControlRegistration extends DelegationControlApi {
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
