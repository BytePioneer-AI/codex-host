import { WORKSPACE_CONTRACT_VERSION } from "@codexhost/shared-contracts";

export { HarnessOutputChannel } from "./output-channel.js";
export type {
  CreateSessionInput,
  HarnessAdapter,
  HarnessError,
  HarnessErrorCode,
  HarnessOutput,
  HarnessResult,
  HarnessSession,
  HarnessSessionState,
  HostAgentMessageItem,
  HostCommand,
  HostCommandExecutionItem,
  HostEvent,
  HostFileChange,
  HostFileChangeItem,
  HostItem,
  HostItemOutcome,
  HostItemSnapshot,
  HostItemUpdate,
  HostTextInput,
  HostToolExecutionItem,
  HostToolOutput,
  ItemCompletedEvent,
  ItemStartedEvent,
  ItemUpdatedEvent,
  SessionFaultedEvent,
  SessionStateChangedEvent,
  TurnCompletedEvent,
  TurnCancelAccepted,
  TurnCancelCommand,
  TurnOutcome,
  TurnStartAccepted,
  TurnStartCommand,
  TurnStartedEvent,
} from "./text-session.js";

export const packageMetadata = {
  name: "@codexhost/harness-adapter",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
} as const;
