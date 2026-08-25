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

export type ClaudeTurnEvent =
  | { type: "compaction.started" }
  | { type: "compaction.completed"; outcome: "succeeded" | "failed" }
  | { type: "text.delta"; messageId: string; delta: string }
  | { type: "reasoning.delta"; messageId: string; delta: string }
  | { type: "reasoning.completed"; messageId: string }
  | { type: "message.completed"; messageId: string; checkpointId?: string }
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
  | { type: "subagent.transcript.changed"; callId: string }
  | { type: "interaction.requested"; request: ClaudeInteractionRequest }
  | {
      type: "interaction.closed";
      requestId: string;
      reason: "responded" | "cancelled" | "superseded";
    };

export interface ClaudeTransportContextUsage {
  usedTokens: number;
  maxTokens: number;
  model: string;
}

export interface ClaudeAutonomousTurn {
  nativeTurnKey: string;
  events: ClaudeTurnEvent[];
  result: ClaudeTransportTurnResult;
  completedSubagents?: Array<{ nativeSubagentId: string; resultSummary?: string }>;
}

export interface ClaudeTurnTransport {
  readonly sessionId: string;
  setAutonomousTurnHandler(handler: (turn: ClaudeAutonomousTurn) => void): void;
  start(): Promise<void>;
  getContextUsage(): Promise<ClaudeTransportContextUsage | null>;
  getPermissionMode(): ClaudePermissionMode;
  setModel(model?: string): Promise<void>;
  setThinkingOption(thinkingOptionId: HarnessThinkingOptionId): Promise<void>;
  setPermissionMode(permissionMode: ClaudePermissionMode): Promise<void>;
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
