import type { HarnessThinkingOptionId, JsonValue } from "@codexhost/shared-contracts";

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

export type ClaudeInteractionRequest = ClaudeApprovalRequest | ClaudeQuestionRequest;

export type ClaudeInteractionResponse =
  | {
      type: "approval";
      requestId: string;
      decision: "allowOnce" | "allowForSession" | "allowAlways" | "deny";
    }
  | { type: "question"; requestId: string; answers: Record<string, string> }
  | { type: "question"; requestId: string; cancelled: true };

export interface ClaudeLastRequestUsage {
  inputTokens: number;
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
      isError: boolean;
      fileChange?: ClaudeNativeFileChange;
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
  | {
      type: "subagent.settled";
      nativeSubagentId: string;
      callId?: string;
      status: "completed" | "failed" | "interrupted";
      resultSummary?: string;
    }
  | { type: "subagent.transcript.changed"; callId: string }
  | { type: "interaction.requested"; request: ClaudeInteractionRequest }
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

export interface ClaudeTransportSessionUsage {
  totalCostUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface ClaudePlanLimitWindow {
  utilizationPercent: number;
  resetsAtUnix?: number;
}

/**
 * Claude.ai subscription plan-window utilization. Arrives two ways: pushed via
 * `rate_limit_event` whenever the CLI makes a real API call (regardless of
 * whether a Turn is active on the transport), or pulled on demand through
 * `getPlanLimit()`. Either source can report both windows at once (Claude Code
 * groups them under `rate_limit_info.unifiedWindows` / `rate_limits`), so both
 * are optional on the same event rather than modeled as one event per window.
 */
export interface ClaudePlanLimitEvent {
  fiveHour?: ClaudePlanLimitWindow;
  sevenDay?: ClaudePlanLimitWindow;
}

/**
 * Which of the two channels above an observation arrived on. These are not
 * equally trustworthy, and the Adapter arbitrates between them by source:
 *
 * - `"pull"` answers "what is the utilization right now?", asked on demand.
 * - `"push"` rides along on whatever API call the CLI happened to make, so it
 *   reports the account state as of *that Session's* last request. An idle
 *   Session's push can therefore carry a value from hours ago, and two
 *   concurrent Sessions routinely disagree.
 *
 * Letting both write the Adapter's account-wide cache made the credits pill
 * flip between an active Session's current value and an idle Session's stale
 * one. See `ClaudeCodeAdapter#recordPlanLimit` for the resulting rules.
 */
export type ClaudePlanLimitSource = "push" | "pull";

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
  setIdleLive(live: boolean): void;
  start(): Promise<void>;
  getContextUsage(): Promise<ClaudeTransportContextUsage | null>;
  /** Pulls the cost and token totals accumulated by the current Session. */
  getSessionUsage(): Promise<ClaudeTransportSessionUsage | null>;
  /**
   * Asks the CLI's `/usage` control channel for the plan-window utilization
   * right now, instead of waiting for the next `rate_limit_event` to arrive on
   * its own. Uses an Anthropic SDK API explicitly marked experimental — `null`
   * on anything short of a clean, available answer (not started, API-key
   * Session, control-channel error, or a future SDK that drops the method).
   */
  getPlanLimit(): Promise<ClaudePlanLimitEvent | null>;
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
  sessionId: string;
  openMode: "create" | "resume";
  model?: string;
  thinkingOptionId: HarnessThinkingOptionId;
  permissionMode: ClaudePermissionMode;
  onPermissionModeChanged(permissionMode: ClaudePermissionMode): void;
  onFault(error: unknown): void;
  onPlanLimit(planLimit: ClaudePlanLimitEvent): void;
}

export interface ClaudeModelInspector {
  readonly stderrTail?: string;
  inspect(): Promise<ClaudeModelInspectionSnapshot>;
  close(): Promise<void>;
}

export interface ClaudeModelInspectorFactoryInput {
  cwd: string;
}

export interface ClaudeAdapterDependencies {
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
