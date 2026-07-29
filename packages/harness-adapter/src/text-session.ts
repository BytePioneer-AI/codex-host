import type {
  HarnessId,
  HarnessInspection,
  HarnessModelRef,
  HarnessSessionCapabilities,
  HostItemId,
  HostTurnId,
  JsonValue,
  NativeSessionRef,
} from "@codexhost/shared-contracts";

export type {
  HarnessInspection,
  HarnessModel,
  HarnessModelCatalog,
  HarnessModelRef,
  HarnessSessionCapabilities,
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

export interface InspectHarnessInput {
  cwd?: string;
  refresh?: boolean;
}

export interface CreateSessionInput {
  kind: "create";
  cwd: string;
  model?: HarnessModelRef;
}

export interface HarnessSessionState {
  nativeRef?: NativeSessionRef;
  effectiveModel?: HarnessModelRef;
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

export interface ModelSelectCommand {
  type: "model.select";
  model: HarnessModelRef;
}

export type HostCommand = TurnStartCommand | TurnCancelCommand | ModelSelectCommand;

export interface TurnStartAccepted {
  turnId: HostTurnId;
}

export interface TurnCancelAccepted {
  cancellationRequested: true;
}

export interface ModelSelectCompleted {
  completed: true;
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
  | TurnCompletedEvent
  | SessionFaultedEvent;

export interface HarnessOutput {
  kind: "event";
  event: HostEvent;
}

export interface HarnessSession {
  readonly harnessId: HarnessId;
  readonly capabilities: HarnessSessionCapabilities;
  readonly initialState: HarnessSessionState;
  readonly outputs: AsyncIterable<HarnessOutput>;

  execute(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>>;
  execute(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>>;
  execute(command: ModelSelectCommand): Promise<HarnessResult<ModelSelectCompleted>>;
  close(): Promise<void>;
}

export interface HarnessAdapter {
  readonly harnessId: HarnessId;

  inspect(input?: InspectHarnessInput): Promise<HarnessInspection>;
  open(input: CreateSessionInput): Promise<HarnessResult<HarnessSession>>;
  close(): Promise<void>;
}
