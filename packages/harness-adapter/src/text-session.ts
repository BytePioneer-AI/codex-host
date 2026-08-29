import type {
  HarnessCommandCatalog,
  HarnessId,
  HarnessInspection,
  HarnessModelRef,
  HarnessPermissionModeId,
  HarnessSessionCapabilities,
  HarnessThinkingOption,
  HarnessThinkingOptionId,
  HostInteractionId,
  HostItemId,
  HostTurnId,
  JsonObject,
  JsonValue,
  NativeCheckpointRef,
  NativeSessionRef,
  NativeTurnRef,
} from "@codexhost/shared-contracts";

import type { HostUsage } from "./usage.js";

export type {
  HarnessInspection,
  HarnessModel,
  HarnessModelCatalog,
  HarnessModelRef,
  HarnessPermissionMode,
  HarnessPermissionModeCatalog,
  HarnessPermissionModeId,
  HarnessSessionCapabilities,
  HarnessThinkingOption,
  HarnessThinkingOptionId,
} from "@codexhost/shared-contracts";

export type HarnessErrorCode =
  | "notInstalled"
  | "unavailable"
  | "authenticationRequired"
  | "sessionNotFound"
  | "sessionBusy"
  | "checkpointNotFound"
  | "unsupported"
  | "invalidRequest"
  | "invalidState"
  | "protocolError"
  | "processExited"
  | "nativeFailure"
  | "internalError";

export interface HarnessError {
  code: HarnessErrorCode;
  message: string;
  retryable: boolean;
  diagnostic?: string;
  stage?: string;
  durationMs?: number;
  stderrTail?: string;
}

export type HarnessResult<T> = { ok: true; value: T } | { ok: false; error: HarnessError };

export interface InspectHarnessInput {
  cwd?: string;
  refresh?: boolean;
}

export interface CreateSessionInput {
  kind: "create";
  cwd: string;
  model?: HarnessModelRef;
  thinkingOptionId?: HarnessThinkingOptionId;
  permissionModeId?: HarnessPermissionModeId;
}

export interface ResumeSessionInput {
  kind: "resume";
  nativeRef: NativeSessionRef;
  cwd: string;
  knownTurnRefs?: NativeTurnRef[];
}

export interface ForkSessionInput {
  kind: "fork";
  sourceRef: NativeSessionRef;
  checkpoint: NativeCheckpointRef;
  /** Execution cwd for the derived Native Session. */
  cwd: string;
}

export interface RollbackLastTurnSessionInput {
  kind: "rollbackLastTurn";
  sourceRef: NativeSessionRef;
  cwd: string;
}

export type OpenSessionInput =
  CreateSessionInput | ResumeSessionInput | ForkSessionInput | RollbackLastTurnSessionInput;

export interface HarnessSessionState {
  nativeRef?: NativeSessionRef;
  effectiveModel?: HarnessModelRef;
  resolvedModelLabel?: string;
  effectiveThinkingOptionId?: HarnessThinkingOptionId;
  availableThinkingOptions?: HarnessThinkingOption[];
  effectivePermissionModeId?: HarnessPermissionModeId;
}

export interface HostTextInput {
  type: "text";
  text: string;
}

export interface TurnStartCommand {
  type: "turn.start";
  turnId: HostTurnId;
  input: HostTextInput[];
}

export interface TurnCancelCommand {
  type: "turn.cancel";
  turnId: HostTurnId;
}

export interface HostChoiceQuestion {
  id: string;
  type: "choice";
  prompt: string;
  options: Array<{
    value: string;
    label: string;
    description?: string;
  }>;
  multiple: boolean;
  allowOther: boolean;
  optional: boolean;
}

export interface HostTextQuestion {
  id: string;
  type: "text";
  prompt: string;
  multiline: boolean;
  secret: boolean;
  optional: boolean;
  placeholder?: string;
  prefill?: string;
}

export type HostQuestion = HostChoiceQuestion | HostTextQuestion;

export interface HostQuestionInteraction {
  type: "question";
  interactionId: HostInteractionId;
  turnId: HostTurnId;
  itemId?: HostItemId;
  title?: string;
  questions: HostQuestion[];
  expiresAt?: string;
}

export type HostApprovalEffect = "allowOnce" | "allowForSession" | "allowAlways" | "deny";

export interface HostApprovalAction {
  id: string;
  label: string;
  effect: HostApprovalEffect;
}

export interface HostApprovalInteraction {
  type: "approval";
  interactionId: HostInteractionId;
  turnId: HostTurnId;
  title: string;
  description?: string;
  subject: { type: "nativeAction" };
  actions: HostApprovalAction[];
  expiresAt?: string;
}

export type HostInteraction = HostQuestionInteraction | HostApprovalInteraction;

export interface HostQuestionResponse {
  type: "question";
  answers: Record<string, string[]>;
  cancelled?: boolean;
}

export interface HostApprovalResponse {
  type: "approval";
  actionId: string;
}

export type HostInteractionResponse = HostQuestionResponse | HostApprovalResponse;

export interface InteractionRespondCommand {
  type: "interaction.respond";
  interactionId: HostInteractionId;
  response: HostInteractionResponse;
}

export interface ModelSelectCommand {
  type: "model.select";
  model: HarnessModelRef;
}

export interface ThinkingSelectCommand {
  type: "thinking.select";
  thinkingOptionId: HarnessThinkingOptionId;
}

export interface PermissionModeSelectCommand {
  type: "permissionMode.select";
  permissionModeId: HarnessPermissionModeId;
}

export interface HarnessCommandInvocation {
  turnId: HostTurnId;
  commandId: string;
  arguments?: JsonObject;
}

export interface HarnessCommandAccepted {
  turnId: HostTurnId;
}

export interface HarnessCommandCapability {
  list(): Promise<HarnessResult<HarnessCommandCatalog>>;
  execute(command: HarnessCommandInvocation): Promise<HarnessResult<HarnessCommandAccepted>>;
}

export type HostCommand =
  | TurnStartCommand
  | TurnCancelCommand
  | InteractionRespondCommand
  | ModelSelectCommand
  | ThinkingSelectCommand
  | PermissionModeSelectCommand;

export interface TurnStartAccepted {
  turnId: HostTurnId;
}

export interface TurnCancelAccepted {
  cancellationRequested: true;
}

export interface InteractionRespondAccepted {
  accepted: true;
}

export interface ModelSelectCompleted {
  completed: true;
}

export interface ThinkingSelectCompleted {
  completed: true;
}

export interface PermissionModeSelectCompleted {
  completed: true;
}

export interface HostAgentMessageItem {
  type: "agentMessage";
  itemId: HostItemId;
  text: string;
}

export interface HostReasoningItem {
  type: "reasoning";
  itemId: HostItemId;
  text: string;
}

export interface HostContextCompactionItem {
  type: "contextCompaction";
  itemId: HostItemId;
}

export interface HostCommandExecutionItem {
  type: "commandExecution";
  itemId: HostItemId;
  command: string;
  cwd?: string;
  output?: string;
  outputTruncated?: boolean;
  exitCode?: number | null;
  durationMs?: number;
}

export interface HostToolOutput {
  content: Array<
    { type: "text"; text: string } | { type: "image"; mimeType: string; base64Data: string }
  >;
  truncated?: boolean;
}

export interface HostToolExecutionItem {
  type: "toolExecution";
  itemId: HostItemId;
  toolName: string;
  namespace?: string;
  arguments: JsonValue;
  output?: HostToolOutput;
  durationMs?: number;
}

export interface HostFileChange {
  path: string;
  kind: "add" | "update" | "delete";
  unifiedDiff: string;
}

export interface HostFileChangeItem {
  type: "fileChange";
  itemId: HostItemId;
  changes: HostFileChange[];
}

export type HostSubagentStatus = "pending" | "running" | "completed" | "failed" | "interrupted";

export interface HostSubagentState {
  subagentId: string;
  nativeSubagentId?: string;
  description: string;
  role?: string;
  background: boolean;
  status: HostSubagentStatus;
  resultSummary?: string;
}

export interface HostSubagentDelegationItem {
  type: "subagentDelegation";
  itemId: HostItemId;
  operation: "spawn" | "send";
  prompt?: string;
  subagents: HostSubagentState[];
}

export type HostItem =
  | HostAgentMessageItem
  | HostReasoningItem
  | HostContextCompactionItem
  | HostCommandExecutionItem
  | HostToolExecutionItem
  | HostFileChangeItem
  | HostSubagentDelegationItem;

export type HostItemUpdate =
  | { type: "text.append"; text: string }
  | { type: "output.append"; text: string }
  | { type: "output.replace"; output: HostToolOutput }
  | { type: "fileChanges.replace"; changes: HostFileChange[] }
  | { type: "subagents.replace"; subagents: HostSubagentState[] };

export type HostItemOutcome =
  | { status: "succeeded" }
  | { status: "failed"; error: HarnessError }
  | { status: "cancelled"; reason?: string };

export interface HostItemSnapshot {
  item: HostItem;
  outcome: HostItemOutcome;
}

export type HistoricalTurnOutcome =
  | { status: "succeeded" }
  | { status: "failed"; error: HarnessError }
  | { status: "cancelled"; reason?: string }
  | { status: "unknown"; reason: string };

export interface HostTurnSnapshot {
  nativeTurnRef: NativeTurnRef;
  checkpoint?: NativeCheckpointRef;
  input: HostTextInput[];
  items: HostItemSnapshot[];
  outcome: HistoricalTurnOutcome;
  model?: HarnessModelRef;
}

export interface HostThreadSnapshot {
  turns: HostTurnSnapshot[];
  /** Current Native Session configuration observed with this history read. */
  state?: HarnessSessionState;
}

export type TurnOutcome =
  | { status: "succeeded"; checkpoint?: NativeCheckpointRef }
  | { status: "failed"; error: HarnessError; checkpoint?: NativeCheckpointRef }
  | { status: "cancelled"; reason?: string; checkpoint?: NativeCheckpointRef };

export interface SessionStateChangedEvent {
  type: "session.state.changed";
  state: HarnessSessionState;
}

export interface SessionUsageChangedEvent {
  type: "session.usage.changed";
  usage: HostUsage | null;
  observedForTurnId?: HostTurnId;
}

export interface SubagentStateChangedEvent {
  type: "subagent.state.changed";
  nativeSubagentId: string;
  status: HostSubagentStatus;
  resultSummary?: string;
}

export interface SubagentTranscriptChangedEvent {
  type: "subagent.transcript.changed";
  nativeSubagentId: string;
}

export interface TurnStartedEvent {
  type: "turn.started";
  turnId: HostTurnId;
}

export interface AutonomousTurnStartedEvent {
  type: "turn.autonomous.started";
  turnId: HostTurnId;
  input: HostTextInput[];
}

export interface ItemStartedEvent {
  type: "item.started";
  turnId: HostTurnId;
  item: HostItem;
}

export interface ItemUpdatedEvent {
  type: "item.updated";
  turnId: HostTurnId;
  itemId: HostItemId;
  update: HostItemUpdate;
}

export interface ItemCompletedEvent {
  type: "item.completed";
  turnId: HostTurnId;
  snapshot: HostItemSnapshot;
}

export interface TurnCompletedEvent {
  type: "turn.completed";
  turnId: HostTurnId;
  nativeTurnRef?: NativeTurnRef;
  outcome: TurnOutcome;
}

export interface InteractionClosedEvent {
  type: "interaction.closed";
  interactionId: HostInteractionId;
  turnId: HostTurnId;
  reason: "responded" | "cancelled" | "expired" | "superseded";
}

export interface SessionFaultedEvent {
  type: "session.faulted";
  error: HarnessError;
}

export type HostEvent =
  | SessionStateChangedEvent
  | SessionUsageChangedEvent
  | SubagentStateChangedEvent
  | SubagentTranscriptChangedEvent
  | TurnStartedEvent
  | AutonomousTurnStartedEvent
  | ItemStartedEvent
  | ItemUpdatedEvent
  | ItemCompletedEvent
  | InteractionClosedEvent
  | TurnCompletedEvent
  | SessionFaultedEvent;

export type HarnessOutput =
  { kind: "event"; event: HostEvent } | { kind: "interaction"; interaction: HostInteraction };

export interface HarnessSession {
  readonly harnessId: HarnessId;
  readonly capabilities: HarnessSessionCapabilities;
  readonly initialState: HarnessSessionState;
  readonly initialUsage: HostUsage | null;
  readonly outputs: AsyncIterable<HarnessOutput>;
  readonly commands?: HarnessCommandCapability;

  refreshUsage?(): Promise<void>;
  readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>>;
  execute(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>>;
  execute(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>>;
  execute(command: InteractionRespondCommand): Promise<HarnessResult<InteractionRespondAccepted>>;
  execute(command: ModelSelectCommand): Promise<HarnessResult<ModelSelectCompleted>>;
  execute(command: ThinkingSelectCommand): Promise<HarnessResult<ThinkingSelectCompleted>>;
  execute(
    command: PermissionModeSelectCommand,
  ): Promise<HarnessResult<PermissionModeSelectCompleted>>;
  close(): Promise<void>;
}

export interface HarnessSubagentCapability {
  readSnapshot(input: {
    parent: NativeSessionRef;
    nativeSubagentId: string;
    cwd: string;
  }): Promise<HarnessResult<HostThreadSnapshot>>;
}

export interface HarnessAdapter {
  readonly harnessId: HarnessId;
  readonly subagents?: HarnessSubagentCapability;

  inspect(input?: InspectHarnessInput): Promise<HarnessInspection>;
  open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>>;
  close(): Promise<void>;
}
