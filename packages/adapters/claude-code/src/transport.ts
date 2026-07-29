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

export interface ClaudeQuestionRequest {
  requestId: string;
  toolUseId: string;
  questions: ClaudeQuestion[];
}

export type ClaudeInteractionResponse =
  { requestId: string; answers: Record<string, string> } | { requestId: string; cancelled: true };

export type ClaudeTurnEvent =
  | { type: "text.delta"; delta: string }
  | { type: "interaction.requested"; request: ClaudeQuestionRequest }
  | {
      type: "interaction.closed";
      requestId: string;
      reason: "responded" | "cancelled" | "superseded";
    };

export interface ClaudeTurnTransport {
  readonly sessionId: string;
  start(): Promise<void>;
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
  onFault(error: unknown): void;
}

export interface ClaudeAdapterDependencies {
  createTransport(input: ClaudeTransportFactoryInput): ClaudeTurnTransport;
  randomUUID(): string;
}
