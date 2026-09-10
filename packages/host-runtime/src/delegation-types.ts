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

/** Paths built only from these characters need no quoting in any target shell. */
const UNQUOTED_COMMAND_PATH = /^[A-Za-z0-9_.:\\/+@=-]+$/u;

/**
 * Renders an executable path as text the caller Agent can run in its own shell.
 * An unquoted path runs identically under POSIX shells, PowerShell, and cmd, so
 * it is preferred whenever the path allows it. Quoting is otherwise shell
 * specific: PowerShell needs the `&` call operator because a leading quoted
 * string is only an expression, and both shells treat backslashes literally, so
 * a Windows path must never be escaped as if it were a C or JSON string.
 */
function commandPath(cliPath: string, platform: NodeJS.Platform): string {
  if (UNQUOTED_COMMAND_PATH.test(cliPath)) return cliPath;
  if (platform === "win32") return `& '${cliPath.replaceAll("'", "''")}'`;
  return `'${cliPath.replaceAll("'", String.raw`'\''`)}'`;
}

/**
 * Follow-up commands are executed by the caller Agent, which reaches this CLI
 * through the Host-provided absolute path rather than `PATH`: the packaged
 * application never places `codexhost` on `PATH`, and an npm installation that
 * does may belong to a different Host.
 */
export function delegationNextCommands(
  environment: NodeJS.ProcessEnv,
  threadId: string,
  platform: NodeJS.Platform = process.platform,
): { read: string; wait: string } {
  const cliPath = environment[DELEGATION_CLI_PATH_ENV];
  const cli = cliPath ? commandPath(cliPath, platform) : "codexhost";
  return {
    read: `${cli} thread read ${threadId}`,
    wait: `${cli} thread wait ${threadId} --timeout-ms 30000`,
  };
}

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
  nextCursor: string | null;
}

export interface DelegationStartInput {
  harnessId: RoutedHarnessId;
  task: string;
  cwd: string;
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
  configuration?: DelegationConfigurationResult;
  next: { read: string; wait: string };
}

export interface ThreadSendInput {
  threadId: string;
  message: string;
  requestId?: string;
  expectedTurnId?: string;
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
  expectedTurnId?: string;
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

export type DelegationUnknownConfigField =
  "harness" | "model" | "thinking" | "permissionMode" | "cwd" | "parent" | "turn" | "delegation";

export interface DelegationThreadStatusView {
  threadId: string;
  harnessId: RoutedHarnessId;
  status: DelegationThreadStatus;
  turn: { turnId: string; status: DelegationThreadStatus } | null;
  revision: string;
  cwd?: string;
  parentThreadId?: string;
  delegationId?: string;
  configuration: {
    requested?: {
      model?: HarnessModelRef;
      thinkingOptionId?: HarnessThinkingOptionId;
      permissionModeId?: string;
    };
    effective?: Pick<
      HarnessSessionState,
      | "effectiveModel"
      | "resolvedModelLabel"
      | "effectiveThinkingOptionId"
      | "effectivePermissionModeId"
    >;
    unknown: DelegationUnknownConfigField[];
  };
}

export interface ThreadStatusInput {
  threadId: string;
}

export interface ThreadWaitManyTarget {
  threadId: string;
  afterRevision?: string;
}

export interface ThreadWaitManyInput {
  targets: ThreadWaitManyTarget[];
  timeoutMs: number;
}

export type ThreadWaitManyTargetResult =
  | {
      threadId: string;
      outcome: "changed" | "timedOut" | "resync";
      revision: string;
      status: DelegationThreadStatusView;
    }
  | {
      threadId: string;
      outcome: "error";
      error: { code: DelegationControlErrorCode; message: string };
    };

export interface ThreadWaitManyResult {
  timedOut: boolean;
  results: ThreadWaitManyTargetResult[];
}

export type DelegationEvidenceKind = "command" | "tool" | "fileChange";

export interface DelegationEvidenceItem {
  itemId: string;
  turnId: string;
  kind: DelegationEvidenceKind;
  command?: string;
  toolName?: string;
  path?: string;
  cwd?: string;
  exitCode?: number | null;
  completed: boolean;
  outputTruncated: boolean;
  output?: string;
  unavailable?: boolean;
}

export interface ThreadEvidenceInput {
  threadId: string;
  turnId?: string;
  itemId?: string;
  cursor?: string;
  limit?: number;
  includeOutput?: boolean;
}

export interface ThreadEvidenceResult {
  threadId: string;
  items: DelegationEvidenceItem[];
  nextCursor: string | null;
}

export interface ThreadConfigurationInput {
  threadId: string;
}

export type JobQuiescence = "confirmed" | "unknown" | "unsupported";

export interface ThreadReleaseInput {
  threadId: string;
  expectedTurnId?: string;
}

export interface ThreadReleaseResult {
  threadId: string;
  released: boolean;
  busy: boolean;
  quiescence: JobQuiescence;
  proof?: { pid?: number; pgid?: number; scope: string };
}

export interface DelegationReconcileInput {
  threadId: string;
  apply?: boolean;
}

export interface DelegationReconcileResult {
  threadId: string;
  dryRun: boolean;
  applied: boolean;
  action: "none" | "reload" | "mark-unconfirmed" | "rejected";
  writes: number;
  reason?: string;
}

export interface DelegationControlApi {
  inspect(input: HarnessInspectInput): Promise<HarnessInspectResult>;
  start(input: DelegationStartInput): Promise<DelegationStartResult>;
  send(input: ThreadSendInput): Promise<ThreadSendResult>;
  cancel(input: ThreadCancelInput): Promise<ThreadCancelResult>;
  read(input: ThreadReadInput): Promise<DelegationThreadSnapshot>;
  wait(input: ThreadWaitInput): Promise<DelegationThreadSnapshot & { timedOut: boolean }>;
  list(input: ThreadListInput): Promise<DelegationThreadListResult>;
  status(input: ThreadStatusInput): Promise<DelegationThreadStatusView>;
  waitMany(input: ThreadWaitManyInput): Promise<ThreadWaitManyResult>;
  evidence(input: ThreadEvidenceInput): Promise<ThreadEvidenceResult>;
  configuration(
    input: ThreadConfigurationInput,
  ): Promise<DelegationThreadStatusView["configuration"]>;
  release(input: ThreadReleaseInput): Promise<ThreadReleaseResult>;
  reconcile(input: DelegationReconcileInput): Promise<DelegationReconcileResult>;
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
  | "RUNTIME_UNREACHABLE"
  | "DELEGATION_FAILED"
  | "STALE_TURN"
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
