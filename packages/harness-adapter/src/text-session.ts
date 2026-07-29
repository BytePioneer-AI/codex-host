import type {
  HarnessId,
  HostInteractionId,
  HostItemId,
  HostTurnId,
  JsonValue,
  NativeSessionRef,
} from "@codexhost/shared-contracts";

export type HarnessErrorCode =
  | "notInstalled"
  | "unavailable"
  | "authenticationRequired"
  | "sessionBusy"
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
}

export type HarnessResult<T> = { ok: true; value: T } | { ok: false; error: HarnessError };

export interface CreateSessionInput {
  kind: "create";
  cwd: string;
}

export interface HarnessSessionState {
  nativeRef?: NativeSessionRef;
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

export type HostInteraction = HostQuestionInteraction;

export interface HostQuestionResponse {
  type: "question";
  answers: Record<string, string[]>;
  cancelled?: boolean;
}

export type HostInteractionResponse = HostQuestionResponse;

export interface InteractionRespondCommand {
  type: "interaction.respond";
  interactionId: HostInteractionId;
  response: HostInteractionResponse;
}

export type HostCommand = TurnStartCommand | TurnCancelCommand | InteractionRespondCommand;

export interface TurnStartAccepted {
  turnId: HostTurnId;
}

export interface TurnCancelAccepted {
  cancellationRequested: true;
}

export interface InteractionRespondAccepted {
  accepted: true;
}

export interface HostAgentMessageItem {
  type: "agentMessage";
  itemId: HostItemId;
  text: string;
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

export type HostItem =
  HostAgentMessageItem | HostCommandExecutionItem | HostToolExecutionItem | HostFileChangeItem;

export type HostItemUpdate =
  | { type: "text.append"; text: string }
  | { type: "output.append"; text: string }
  | { type: "output.replace"; output: HostToolOutput }
  | { type: "fileChanges.replace"; changes: HostFileChange[] };

export type HostItemOutcome =
  | { status: "succeeded" }
  | { status: "failed"; error: HarnessError }
  | { status: "cancelled"; reason?: string };

export interface HostItemSnapshot {
  item: HostItem;
  outcome: HostItemOutcome;
}

export type TurnOutcome =
  | { status: "succeeded" }
  | { status: "failed"; error: HarnessError }
  | { status: "cancelled"; reason?: string };

export interface SessionStateChangedEvent {
  type: "session.state.changed";
  state: HarnessSessionState;
}

export interface TurnStartedEvent {
  type: "turn.started";
  turnId: HostTurnId;
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
  | TurnStartedEvent
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
  readonly initialState: HarnessSessionState;
  readonly outputs: AsyncIterable<HarnessOutput>;

  execute(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>>;
  execute(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>>;
  execute(command: InteractionRespondCommand): Promise<HarnessResult<InteractionRespondAccepted>>;
  close(): Promise<void>;
}

export interface HarnessAdapter {
  readonly harnessId: HarnessId;

  open(input: CreateSessionInput): Promise<HarnessResult<HarnessSession>>;
  close(): Promise<void>;
}
