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
  HostEvent,
  HostItem,
  HostItemOutcome,
  HostItemSnapshot,
  HostItemUpdate,
  HostTextInput,
  ItemCompletedEvent,
  ItemStartedEvent,
  ItemUpdatedEvent,
  SessionFaultedEvent,
  SessionStateChangedEvent,
  TurnCompletedEvent,
  TurnOutcome,
  TurnStartAccepted,
  TurnStartCommand,
  TurnStartedEvent,
} from "./text-session.js";

export const packageMetadata = {
  name: "@codexhost/harness-adapter",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
} as const;
