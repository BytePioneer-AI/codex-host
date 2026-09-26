import type { RoutedHarnessId } from "@codexhost/protocol-core";
import type {
  HarnessInspection,
  HarnessModelRef,
  HarnessSessionState,
  HarnessThinkingOptionId,
} from "@codexhost/harness-adapter";

export const DELEGATION_RUNTIME_ENDPOINT_ENV = "CODEXHOST_RUNTIME_ENDPOINT";
export const DELEGATION_RUNTIME_TOKEN_ENV = "CODEXHOST_RUNTIME_TOKEN";
export const DELEGATION_CLI_PATH_ENV = "CODEXHOST_CLI_PATH";
export const DELEGATION_THREAD_ID_ENV = "CODEXHOST_THREAD_ID";
/** Below the 30 min prompt-cache lifetime of the notified agent, so a wake-up still hits its cache. */
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

export interface DelegationThreadSnapshot {
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
  /** Present only when the caller asked `thread send` to also watch the Thread. */
  watch?: ThreadWatchResult | { state: "notRegistered"; reason: string };
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

/** A watch as requested by a caller; the Host infers an omitted notified Thread. */
export type ThreadWatchRequest = Omit<ThreadWatchInput, "notifyThreadId"> & {
  notifyThreadId?: string;
};

export type ThreadWatchOutcome =
  | "completed"
  | "failed"
  | "interrupted"
  /** The Thread was still running when the watch expired. */
  | "timedOut"
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
}

export interface ThreadWatchEntry {
  threadId: string;
  notifyThreadId: string;
  state: "watching" | "pendingDelivery" | "undeliverable";
  outcome?: ThreadWatchOutcome;
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
  watch(request: ThreadWatchRequest): Promise<ThreadWatchResult>;
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
  list(input: ThreadListInput): Promise<DelegationThreadListResult>;
}

export interface DelegationControlRegistration extends DelegationControlApi {
  canHandleStart(input: DelegationStartInput): boolean | Promise<boolean>;
  ownsThread(threadId: string): boolean | Promise<boolean>;
  /** Threads with an active Turn; used to infer a caller that did not identify itself. */
  activeThreadIds?(): string[] | Promise<string[]>;
}

export type DelegationControlErrorCode =
  | "INVALID_ARGUMENT"
  | "HARNESS_NOT_FOUND"
  | "THREAD_NOT_FOUND"
  | "THREAD_BUSY"
  | "PARENT_THREAD_AMBIGUOUS"
  | "RUNTIME_UNREACHABLE"
  | "DELEGATION_FAILED"
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
