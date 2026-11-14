import type {
  AvailableCommand,
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type {
  HostApprovalInteraction,
  HostEvent,
  HostItemOutcome,
  HostItemSnapshot,
  HostQuestionInteraction,
  HostQuestionResponse,
  HostTurnSnapshot,
  SubagentConfiguration,
} from "@codexhost/harness-adapter";
import type {
  HarnessCommandCatalog,
  HostInteractionId,
  HostTurnId,
  NativeTurnRef,
} from "@codexhost/shared-contracts";

import type { AntigravityAcpEvent } from "./acp-types.js";

export interface AntigravityElicitationQuestionMapping {
  questionId: string;
  selectKey: string;
  otherKey?: string;
  multiSelect: boolean;
  optionValueToConst: ReadonlyMap<string, string>;
}

export interface AntigravityElicitationFieldMap {
  questions: readonly AntigravityElicitationQuestionMapping[];
}

export function projectAcpSessionUpdate(
  _rawUpdate: Record<string, unknown>,
): AntigravityAcpEvent | null {
  throw new Error("projectAcpSessionUpdate stub");
}

export function projectAcpApprovalInteraction(_params: {
  interactionId: HostInteractionId;
  sessionId: string;
  turnId: HostTurnId;
  cwd: string;
  request: RequestPermissionRequest;
}): {
  interaction: HostApprovalInteraction;
  actionToOptionId: ReadonlyMap<string, string>;
} {
  throw new Error("projectAcpApprovalInteraction stub");
}

export function buildAcpPermissionResponse(_params: {
  actionId: string;
  actionToOptionId: ReadonlyMap<string, string>;
}): RequestPermissionResponse {
  throw new Error("buildAcpPermissionResponse stub");
}

export function projectAcpQuestionInteraction(_params: {
  interactionId: HostInteractionId;
  sessionId: string;
  turnId: HostTurnId;
  request: CreateElicitationRequest;
  rawQuestions?: unknown;
}): {
  interaction: HostQuestionInteraction;
  fieldMap: AntigravityElicitationFieldMap;
} {
  throw new Error("projectAcpQuestionInteraction stub");
}

export function buildAcpElicitationResponse(_params: {
  response: HostQuestionResponse;
  fieldMap: AntigravityElicitationFieldMap;
}): CreateElicitationResponse {
  throw new Error("buildAcpElicitationResponse stub");
}

export interface AntigravityToolTrackerOptions {
  turnId: HostTurnId;
  cwd: string;
  outputLimit?: number;
  parentConfiguration?: SubagentConfiguration;
  emit: (event: HostEvent) => void;
  onSubagentSpawned?: (subagentId: string, item: HostItemSnapshot) => void;
}

export class AntigravityToolTracker {
  constructor(_options: AntigravityToolTrackerOptions) {}

  rawToolInput(_toolCallId: string): unknown {
    return undefined;
  }

  handleToolEvent(
    _event: Extract<AntigravityAcpEvent, { type: "tool.call" | "tool.update" }>,
  ): void {
    throw new Error("AntigravityToolTracker stub");
  }

  finishPending(_outcome: HostItemOutcome): void {
    throw new Error("AntigravityToolTracker stub");
  }

  completedSnapshots(): HostItemSnapshot[] {
    return [];
  }
}

export function projectReplayedEventsToTurns(_params: {
  nativeSessionId: string;
  cwd: string;
  events: readonly AntigravityAcpEvent[];
  knownTurnRefs?: readonly NativeTurnRef[];
  outputLimit?: number;
}): HostTurnSnapshot[] {
  throw new Error("projectReplayedEventsToTurns stub");
}

export function buildLiveCommandCatalog(
  _commands: readonly AvailableCommand[],
): HarnessCommandCatalog {
  throw new Error("buildLiveCommandCatalog stub");
}
