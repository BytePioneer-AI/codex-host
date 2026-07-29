import type {
  HarnessId,
  HostItemId,
  HostTurnId,
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

export type HostCommand = TurnStartCommand;

export interface TurnStartAccepted {
  turnId: HostTurnId;
}

export interface HostAgentMessageItem {
  type: "agentMessage";
  itemId: HostItemId;
  text: string;
}

export type HostItem = HostAgentMessageItem;

export type HostItemUpdate = { type: "text.append"; text: string };

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
  readonly initialState: HarnessSessionState;
  readonly outputs: AsyncIterable<HarnessOutput>;

  execute(command: HostCommand): Promise<HarnessResult<TurnStartAccepted>>;
  close(): Promise<void>;
}

export interface HarnessAdapter {
  readonly harnessId: HarnessId;

  open(input: CreateSessionInput): Promise<HarnessResult<HarnessSession>>;
  close(): Promise<void>;
}
