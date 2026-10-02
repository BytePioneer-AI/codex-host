import type {
  HostApprovalInteraction,
  HostItemOutcome,
  HostQuestion,
  HostQuestionResponse,
  HostThreadSnapshot,
  HostUsage,
} from "@codexhost/harness-adapter";
import type { HarnessThinkingOption } from "@codexhost/shared-contracts";

export type HermesTransportFaultKind =
  "notInstalled" | "authenticationRequired" | "unavailable" | "protocolError" | "processExited";

export class HermesTransportError extends Error {
  readonly diagnostic: string | undefined;
  constructor(
    readonly kind: HermesTransportFaultKind,
    message: string,
    options?: ErrorOptions & { diagnostic?: string },
  ) {
    super(message, options);
    this.diagnostic = options?.diagnostic;
    this.name = "HermesTransportError";
  }
}

export function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  operation: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new HermesTransportError("unavailable", `${operation} timed out`)),
        milliseconds,
      );
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

export interface HermesNativeCommand {
  name: string;
  description: string;
  input?: { hint: string } | null;
}
export type HermesToolContent =
  | { type: "diff"; path: string; oldText?: string | null; newText: string }
  | {
      type: "content";
      content: { type: "text"; text: string } | { type: "image"; mimeType: string; data: string };
    };
export interface HermesToolUpdate {
  toolCallId: string;
  title?: string | null;
  name?: string | null;
  rawInput?: unknown;
  rawOutput?: unknown;
  status?: "pending" | "in_progress" | "completed" | "failed" | null;
  content?: HermesToolContent[] | null;
}
export type HermesTransportEvent =
  | { type: "agent.text"; text: string }
  | { type: "agent.thought"; text: string }
  | { type: "tool.call"; toolCallId: string; update: HermesToolUpdate }
  | { type: "tool.update"; toolCallId: string; update: HermesToolUpdate }
  | { type: "usage"; used?: number; size?: number };
export interface HermesOpenResult {
  sessionId: string;
  session: {
    sessionId: string;
    models: {
      availableModels: { modelId: string; name: string }[];
      currentModelId?: string;
    } | null;
    modes: { currentModeId: string; availableModes: { id: string; name: string }[] } | null;
    thinkingOptions?: HarnessThinkingOption[];
    currentThinkingOptionId?: string;
  };
}
export interface HermesPermissionRequest {
  title?: string;
  description?: string;
  signal?: AbortSignal;
  options: HostApprovalInteraction["actions"];
}
export interface HermesQuestionRequest {
  signal?: AbortSignal;
  title?: string;
  questions: HostQuestion[];
}
export interface HermesPromptResponse {
  stopReason: "end_turn" | "cancelled";
  /** Authoritative successful message.complete text, not a guess from stream order. */
  finalAnswerText?: string;
  usage?: HostUsage;
  compactionOutcome?: HostItemOutcome;
}
export interface HermesSessionTransport {
  onFault: (error: HermesTransportError) => void;
  readonly availableCommands: readonly HermesNativeCommand[];
  nativeCommandName(text: string): string | null;
  runTurn(
    text: string,
    onEvent: (event: HermesTransportEvent) => void,
    onPermission: (request: HermesPermissionRequest) => Promise<string | null>,
    onQuestion?: (request: HermesQuestionRequest) => Promise<HostQuestionResponse>,
  ): Promise<HermesPromptResponse>;
  setModel(modelId: string): Promise<void>;
  setPermissionMode(modeId: string): Promise<void>;
  setThinking?(optionId: string): Promise<string>;
  readNativeSnapshot?(): Promise<HostThreadSnapshot>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}
