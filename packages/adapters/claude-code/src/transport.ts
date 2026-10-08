import type { ClaudeUsageRecord } from "./claude-usage.js";
import type {
  HarnessAccountSnapshot,
  HarnessThinkingOptionId,
  JsonValue,
} from "@codexhost/shared-contracts";

import type { ClaudeSlashCommandSnapshot } from "./slash-commands.js";
import type { ClaudeNativeFileChange } from "./file-change.js";
import type { ClaudeModelInspectionSnapshot } from "./model-catalog.js";
import type { ClaudePermissionMode } from "./permission-modes.js";

export type ClaudeTransportFailureKind =
  "authentication" | "cancellationUnproven" | "native" | "protocol" | "textConflict";

export type ClaudeTransportTurnResult =
  | { status: "succeeded" }
  | { status: "cancelled"; reason: string }
  | { status: "failed"; kind: ClaudeTransportFailureKind };

export interface ClaudeQuestionOption {
  label: string;
  description: string;
}

export interface ClaudeQuestion {
  question: string;
  header: string;
  options: ClaudeQuestionOption[];
  multiSelect: boolean;
}

export type ClaudeApprovalSuggestionScope = "session" | "always";

export interface ClaudeApprovalRequest {
  type: "approval";
  requestId: string;
  title: string;
  description?: string;
  suggestedScope?: ClaudeApprovalSuggestionScope;
}

export interface ClaudeQuestionRequest {
  type: "question";
  requestId: string;
  questions: ClaudeQuestion[];
}

export interface ClaudePlanApprovalRequest {
  type: "planApproval";
  requestId: string;
  /** Full SDK-provided plan text; null means no reviewable plan was provided. */
  plan: string | null;
}

export type ClaudeInteractionRequest =
  ClaudeApprovalRequest | ClaudeQuestionRequest | ClaudePlanApprovalRequest;

export type ClaudeInteractionResponse =
  | {
      type: "approval";
      requestId: string;
      decision: "allowOnce" | "allowForSession" | "allowAlways" | "deny";
    }
  | { type: "question"; requestId: string; answers: Record<string, string> }
  | { type: "question"; requestId: string; cancelled: true };

export interface ClaudeLastRequestUsage {
  requestId?: string;
  model?: string;
  provider?: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export type ClaudeTurnEvent =
  | { type: "segment.started" }
  | { type: "subagents.live"; nativeSubagentIds: string[] }
  | { type: "compaction.started" }
  | { type: "compaction.completed"; outcome: "succeeded" | "failed" }
  | { type: "text.delta"; messageId: string; delta: string }
  | { type: "reasoning.delta"; messageId: string; delta: string }
  | { type: "reasoning.completed"; messageId: string }
  | {
      type: "message.completed";
      messageId: string;
      checkpointId?: string;
      lastRequestUsage?: ClaudeLastRequestUsage;
    }
  | { type: "tool.started"; callId: string; toolName: string; arguments: JsonValue }
  | { type: "tool.progress"; callId: string; elapsedMs: number }
  | {
      type: "tool.completed";
      callId: string;
      toolName: string;
      outputText?: string;
      structuredResult?: JsonValue;
      isError: boolean;
      fileChange?: ClaudeNativeFileChange;
      /** Native Bash moved the command to the background; it keeps running after this result. */
      backgroundTaskId?: string;
      /** Output file the backgrounded command streams to, named in the native result. */
      backgroundOutputFile?: string;
    }
  | {
      type: "subagent.started";
      callId: string;
      operation: "spawn" | "send";
      description: string;
      prompt?: string;
      role?: string;
      background: boolean;
      nativeSubagentId?: string;
    }
  | {
      type: "subagent.updated";
      callId: string;
      status: "pending" | "running" | "completed" | "failed" | "interrupted";
      description?: string;
      role?: string;
      nativeSubagentId?: string;
      resultSummary?: string;
    }
  | {
      type: "subagent.completed";
      callId: string;
      isError: boolean;
      continuesInBackground?: boolean;
      nativeSubagentId?: string;
      resultSummary?: string;
    }
  /**
   * A native `task_notification`. Background Agents and background commands share
   * it and it carries no task type: the Session routes it by `callId`.
   */
  | {
      type: "subagent.settled";
      nativeSubagentId: string;
      callId?: string;
      status: "completed" | "failed" | "interrupted";
      resultSummary?: string;
      /** The task's native output file. */
      outputFile?: string;
    }
  | { type: "subagent.transcript.changed"; callId: string }
  | { type: "interaction.requested"; request: ClaudeInteractionRequest }
  | {
      type: "interaction.closed";
      requestId: string;
      reason: "responded" | "cancelled" | "superseded";
    }
  /** One finished native model request, for Host usage metering. */
  | { type: "usage.request"; record: ClaudeUsageRecord }
  | {
      type: "usage.result";
      totalCostUsd?: number;
      modelUsage?: Array<{ inputTokens: number; outputTokens: number }>;
      lastRequestUsage?: ClaudeLastRequestUsage;
    };

export interface ClaudeTransportContextUsage {
  usedTokens: number;
  maxTokens: number;
  model: string;
}

export interface ClaudePlanLimitWindow {
  utilizationPercent: number;
  resetsAtUnix?: number;
}

/**
 * Claude.ai subscription plan-window utilization from stable `rate_limit_event`
 * pushes. Both windows are optional because one event may report either or both.
 */
export interface ClaudePlanLimitEvent {
  fiveHour?: ClaudePlanLimitWindow;
  sevenDay?: ClaudePlanLimitWindow;
}

export interface ClaudeIdleTurnHandler {
  onEvent(event: ClaudeTurnEvent): void;
  onTerminal(result: ClaudeTransportTurnResult): void;
}

/**
 * A native Segment that no requested Turn owns, such as Claude answering a background task
 * notification. `start` runs once, when the Segment first produces Root output or reaches its
 * Terminal without any; the Segment's events and Terminal then follow live.
 */
export interface ClaudeAutonomousTurnHandler extends ClaudeIdleTurnHandler {
  start(nativeTurnKey: string): void;
}

/** The running Turn ended before Claude queued this steer. */
export class ClaudeSteerMissedTurnError extends Error {
  constructor() {
    super("Claude Code steer missed the active Turn");
    this.name = "ClaudeSteerMissedTurnError";
  }
}

export interface ClaudeTurnTransport {
  readonly sessionId: string;
  setAutonomousTurnHandler(handler: ClaudeAutonomousTurnHandler): void;
  setIdleTurnHandler(handler: ClaudeIdleTurnHandler | null): void;
  /**
   * Receives settlements that have no preceding unpublished Subagent lifecycle.
   * A task-notification Segment may never produce a Terminal, so independent
   * settlements must not wait for that Segment. Settlements that depend on an
   * unpublished creation/reactivation wait with it to preserve causal order.
   * Without a Thread handler, settlements wait until the Segment starts its autonomous Turn.
   */
  setThreadEventHandler(handler: ((event: ClaudeTurnEvent) => void) | null): void;
  setIdleLive(live: boolean): void;
  /** Native background tasks of any type are still active on this process. */
  hasBackgroundTasks(): boolean;
  /** Requests a native stop; the task still settles through its `task_notification`. */
  stopBackgroundTask(taskId: string): Promise<void>;
  start(): Promise<void>;
  getContextUsage(): Promise<ClaudeTransportContextUsage | null>;
  /** Live slash commands of the started native Session, when known. */
  slashCommands?(): ClaudeSlashCommandSnapshot | null;
  getPermissionMode(): ClaudePermissionMode;
  setModel(model?: string): Promise<void>;
  setThinkingOption(thinkingOptionId: HarnessThinkingOptionId): Promise<void>;
  setPermissionMode(permissionMode: ClaudePermissionMode): Promise<void>;
  compact(
    userMessageId: string,
    customInstructions: string | undefined,
    onEvent: (event: ClaudeTurnEvent) => void,
  ): Promise<ClaudeTransportTurnResult>;
  init(
    userMessageId: string,
    onEvent: (event: ClaudeTurnEvent) => void,
  ): Promise<ClaudeTransportTurnResult>;
  recap(
    userMessageId: string,
    onEvent: (event: ClaudeTurnEvent) => void,
  ): Promise<ClaudeTransportTurnResult>;
  /**
   * Rejects while a requested or autonomous Turn runs. A Segment that has not produced Root
   * output yet belongs to no Turn: the requested Turn takes over its native stream, starting
   * with the events that Segment still holds.
   */
  runTurn(
    text: string,
    userMessageId: string,
    onEvent: (event: ClaudeTurnEvent) => void,
  ): Promise<ClaudeTransportTurnResult>;
  /**
   * Inserts text into the active Turn at Claude's tool boundary (`priority: "next"`).
   * Resolves when Claude emits `command_lifecycle` `queued` for that message: from then on Claude
   * owns its delivery, joining the running Turn after the current tool call, or running it next.
   * Rejects with {@link ClaudeSteerMissedTurnError} when the Turn ends first.
   */
  steer(text: string, messageId: string): Promise<void>;
  respondToInteraction(response: ClaudeInteractionResponse): Promise<void>;
  /** Interrupts the running requested or autonomous Turn; its Terminal still follows. */
  abort(): Promise<void>;
  close(): Promise<void>;
}

export interface ClaudeTransportFactoryInput {
  cwd: string;
  environment?: NodeJS.ProcessEnv;
  sessionId: string;
  openMode: "create" | "resume";
  model?: string;
  thinkingOptionId: HarnessThinkingOptionId;
  permissionMode: ClaudePermissionMode;
  /** Native prerequisite for a later live `bypassPermissions` selection. */
  allowDangerouslySkipPermissions: boolean;
  onPermissionModeChanged(permissionMode: ClaudePermissionMode): void;
  onFault(error: unknown): void;
  onPlanLimit(planLimit: ClaudePlanLimitEvent): void;
}

export interface ClaudeModelInspector {
  readonly stderrTail?: string;
  inspect(): Promise<ClaudeModelInspectionSnapshot>;
  inspectAccount?(): Promise<HarnessAccountSnapshot | null>;
  close(): Promise<void>;
}

export interface ClaudeModelInspectorFactoryInput {
  cwd: string;
}

export interface ClaudeAdapterDependencies {
  /** Whether Claude Code accepts `bypassPermissions` in the Session environment. */
  bypassPermissionsAvailable(environment?: NodeJS.ProcessEnv): boolean;
  createInspector(input: ClaudeModelInspectorFactoryInput): ClaudeModelInspector;
  createTransport(input: ClaudeTransportFactoryInput): ClaudeTurnTransport;
  deleteSession(input: { cwd: string; sessionId: string }): Promise<void>;
  forkSession(input: {
    checkpointId: string;
    cwd: string;
    sourceSessionId: string;
  }): Promise<{ sessionId: string }>;
  getSessionInfo(input: { sessionId: string }): Promise<{ cwd?: string } | undefined>;
  inspectInstallation(): void;
  /** Null means the native transcript is absent, not a successfully read empty history. */
  readSessionMessages(input: { cwd: string; sessionId: string }): Promise<unknown[] | null>;
  readSubagentMessages(input: {
    cwd: string;
    sessionId: string;
    nativeSubagentId: string;
  }): Promise<unknown[]>;
  randomUUID(): string;
}
