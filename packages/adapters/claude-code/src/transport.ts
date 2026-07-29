export type ClaudeTransportFailureKind =
  "authentication" | "cancellationUnproven" | "native" | "textConflict";

export type ClaudeTransportTurnResult =
  | { status: "succeeded" }
  | { status: "cancelled"; reason: string }
  | { status: "failed"; kind: ClaudeTransportFailureKind };

export interface ClaudeTurnTransport {
  readonly sessionId: string;
  start(): Promise<void>;
  runTurn(
    text: string,
    userMessageId: string,
    onTextDelta: (delta: string) => void,
  ): Promise<ClaudeTransportTurnResult>;
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
