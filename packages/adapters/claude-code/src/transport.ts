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

/** One agent of a native Workflow run, as its latest `workflow_progress` entry reports it. */
export interface ClaudeWorkflowAgent {
  /** Native 1-based ordinal of the agent call within the run; stable for the run. */
  index: number;
  label: string;
  /** `queued` until the agent starts; `running` covers native `start` and `progress`. */
  state: "queued" | "running" | "done" | "error";
  agentId?: string;
  phaseTitle?: string;
  agentType?: string;
  model?: string;
  resultPreview?: string;
  error?: string;
}

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
  /** The Root called the native Workflow tool; its run has not been registered yet. */
  | { type: "workflow.started"; callId: string; name?: string }
  /**
   * Native task frames of a Workflow run. `agents` lists only the agents this frame reports;
   * a frame without it still carries the run identity.
   */
  | {
      type: "workflow.updated";
      callId: string;
      taskId?: string;
      description?: string;
      agents?: ClaudeWorkflowAgent[];
    }
  /** Agent activity inside a run that reports no agent state, such as a tool call. */
  | { type: "workflow.activity"; callId: string }
  /** The Workflow tool returned; a launched run keeps working in the background. */
  | {
      type: "workflow.launched";
      callId: string;
      isError: boolean;
      background: boolean;
      taskId?: string;
      resultSummary?: string;
    }
  | {
      type: "interaction.requested";
      request: ClaudeInteractionRequest;
      /**
       * Requested by a native agent rather than the Root. It stays pending across the Root
       * terminal while that agent keeps running.
       */
      agentScoped?: boolean;
    }
  | {
      type: "interaction.closed";
      requestId: string;
      reason: "responded" | "cancelled" | "superseded";
    }
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

export interface ClaudeAutonomousTurn {
  nativeTurnKey: string;
  events: ClaudeTurnEvent[];
  result: ClaudeTransportTurnResult;
}

export interface ClaudeIdleTurnHandler {
  onEvent(event: ClaudeTurnEvent): void;
  onTerminal(result: ClaudeTransportTurnResult): void;
}

export interface ClaudeTurnTransport {
  readonly sessionId: string;
  setAutonomousTurnHandler(handler: (turn: ClaudeAutonomousTurn) => void): void;
  setIdleTurnHandler(handler: ClaudeIdleTurnHandler | null): void;
  /**
   * Receives settlements that have no preceding buffered Subagent lifecycle.
   * A task-notification Segment may never produce a Terminal, so independent
   * settlements must not wait for Turn batching. Settlements that depend on a
   * buffered creation/reactivation stay in that batch to preserve causal order.
   * Without a Thread handler, settlements remain in the autonomous Turn batch.
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
  runTurn(
    text: string,
    userMessageId: string,
    onEvent: (event: ClaudeTurnEvent) => void,
  ): Promise<ClaudeTransportTurnResult>;
  respondToInteraction(response: ClaudeInteractionResponse): Promise<void>;
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
  readSessionMessages(input: { cwd: string; sessionId: string }): Promise<unknown[]>;
  readSubagentMessages(input: {
    cwd: string;
    sessionId: string;
    nativeSubagentId: string;
  }): Promise<unknown[]>;
  randomUUID(): string;
}
