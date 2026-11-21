import type {
  AvailableCommand,
  CreateElicitationRequest,
  CreateElicitationResponse,
  InitializeResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type { HarnessErrorCode } from "@codexhost/harness-adapter";

export const ANTIGRAVITY_HARNESS_ID = "antigravity" as const;
export const ANTIGRAVITY_MIN_ACP_VERSION = "1.5.8";

export type AntigravityTransportFaultKind =
  | "notInstalled"
  | "authenticationRequired"
  | "unavailable"
  | "protocolError"
  | "processExited"
  | "unsupported";

export class AntigravityTransportError extends Error {
  readonly diagnostic: string | undefined;
  readonly retryable: boolean;

  constructor(
    readonly kind: AntigravityTransportFaultKind,
    message: string,
    options?: ErrorOptions & { diagnostic?: string; retryable?: boolean },
  ) {
    super(message, options);
    this.name = "AntigravityTransportError";
    this.diagnostic = options?.diagnostic;
    this.retryable = options?.retryable ?? (kind === "unavailable" || kind === "processExited");
  }

  toHarnessErrorCode(): HarnessErrorCode {
    switch (this.kind) {
      case "notInstalled":
        return "notInstalled";
      case "authenticationRequired":
        return "authenticationRequired";
      case "protocolError":
        return "protocolError";
      case "processExited":
        return "processExited";
      case "unsupported":
        return "unsupported";
      case "unavailable":
        return "nativeFailure";
    }
  }
}

export interface AntigravityAcpConfigOptionChoice {
  value: string;
  name: string;
  description?: string;
}

export interface AntigravityAcpConfigOption {
  id: string;
  name: string;
  category?: string;
  type?: string;
  currentValue: string;
  options: AntigravityAcpConfigOptionChoice[];
}

export interface AntigravityAcpAvailableModel {
  modelId: string;
  name: string;
}

export interface AntigravityAcpModeEntry {
  id: string;
  name: string;
  description?: string;
}

export interface AntigravityAcpTierInfo {
  id?: string;
  name?: string;
  upgradeUri?: string;
}

export interface AntigravityAcpSessionOpenResult {
  sessionId: string;
  models?: {
    currentModelId?: string;
    availableModels: AntigravityAcpAvailableModel[];
  };
  modes?: {
    currentModeId?: string;
    availableModes: AntigravityAcpModeEntry[];
  };
  configOptions?: AntigravityAcpConfigOption[];
  tier?: AntigravityAcpTierInfo;
}

export type AntigravityAcpEvent =
  | { type: "user.text"; text: string; nativeTurnIndex?: number }
  | { type: "agent.text"; text: string }
  | { type: "agent.thought"; text: string }
  | {
      type: "tool.call";
      toolCallId: string;
      name: string;
      title?: string;
      kind?: string;
      status?: string;
      args?: unknown;
      rawInput?: unknown;
      rawOutput?: unknown;
      locations?: Array<{ path: string }>;
      content?: unknown;
    }
  | {
      type: "tool.update";
      toolCallId: string;
      name?: string;
      title?: string;
      kind?: string;
      status?: string;
      args?: unknown;
      rawInput?: unknown;
      rawOutput?: unknown;
      locations?: Array<{ path: string }>;
      content?: unknown;
    }
  | { type: "usage.context"; used: number; size: number }
  | { type: "config.update"; configOptions: AntigravityAcpConfigOption[] }
  | { type: "mode.update"; currentModeId: string }
  | { type: "commands.update"; commands: AvailableCommand[] }
  | { type: "session.info"; title?: string };

export interface AntigravityPromptUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
}

export interface AntigravityPromptResult {
  stopReason: string;
  usage?: AntigravityPromptUsage;
}

export type AntigravityPromptInputPart =
  { type: "text"; text: string } | { type: "image"; mimeType: string; data: string };

export interface AntigravityActivePromptHandler {
  /** Called at the wire response boundary, before any subsequent Session events. */
  onResponse?(): void;
  onEvent(event: AntigravityAcpEvent): void;
  onPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  onElicitation(request: CreateElicitationRequest): Promise<CreateElicitationResponse>;
}

export type AntigravitySessionEventHandler = (event: AntigravityAcpEvent) => void;

export interface AntigravityOpenAcpSessionInput {
  kind: "create" | "resume";
  sessionId?: string;
  cwd: string;
  systemPromptAppend?: string;
  additionalDirectories?: string[];
}

export interface AntigravityAcpTransportOptions {
  cwd: string;
  command?: string;
  environment?: NodeJS.ProcessEnv;
  skipPermissions?: boolean;
  commandTimeoutMs?: number;
  closeTimeoutMs?: number;
  onFault?: (error: AntigravityTransportError) => void;
}

export interface AntigravityAcpTransportLike {
  readonly sessionId: string | null;
  readonly isClosed: boolean;
  readonly skipPermissions: boolean;
  setSessionEventHandler(handler: AntigravitySessionEventHandler | null): void;
  initialize(): Promise<InitializeResponse>;
  openSession(input: AntigravityOpenAcpSessionInput): Promise<{
    opened: AntigravityAcpSessionOpenResult;
  }>;
  setMode(modeId: string): Promise<void>;
  setConfigOption(configId: string, value: string): Promise<AntigravityAcpConfigOption[]>;
  prompt(
    parts: readonly AntigravityPromptInputPart[],
    handler: AntigravityActivePromptHandler,
  ): Promise<AntigravityPromptResult>;
  cancel(): Promise<void>;
  closeSession(): Promise<void>;
  close(): Promise<void>;
}
