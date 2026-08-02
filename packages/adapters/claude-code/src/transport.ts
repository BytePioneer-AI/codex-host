import type { ClaudeModelInspectionSnapshot } from "./model-catalog.js";
import type { ClaudePermissionMode } from "./permission-modes.js";

export type ClaudeTransportFailureKind =
  "authentication" | "cancellationUnproven" | "native" | "textConflict";

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
  | { type: "text.delta"; delta: string }
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

export interface ClaudeTurnTransport {
  readonly sessionId: string;
  start(): Promise<void>;
  getContextUsage(): Promise<ClaudeTransportContextUsage | null>;
  getPermissionMode(): ClaudePermissionMode;
  setModel(model?: string): Promise<void>;
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
  permissionMode: ClaudePermissionMode;
  onPermissionModeChanged(permissionMode: ClaudePermissionMode): void;
  onFault(error: unknown): void;
}

export interface ClaudeModelInspector {
  inspect(): Promise<ClaudeModelInspectionSnapshot>;
  close(): Promise<void>;
}

export interface ClaudeModelInspectorFactoryInput {
  cwd: string;
}

export interface ClaudeAdapterDependencies {
  createInspector(input: ClaudeModelInspectorFactoryInput): ClaudeModelInspector;
  createTransport(input: ClaudeTransportFactoryInput): ClaudeTurnTransport;
  inspectInstallation(): void;
  readSessionMessages(input: { cwd: string; sessionId: string }): Promise<unknown[]>;
  randomUUID(): string;
}
