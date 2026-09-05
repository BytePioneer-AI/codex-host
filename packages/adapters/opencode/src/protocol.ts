import type {
  AssistantMessage,
  Command,
  Event,
  PermissionRequest,
  PermissionRuleset,
  Provider,
  QuestionAnswer,
  QuestionRequest,
  Session,
  SessionStatus,
  SnapshotFileDiff,
} from "@opencode-ai/sdk/v2";

import type { OpenCodeNativeModelRef } from "./model-catalog.js";
import type { OpenCodeMessageWithParts } from "./history.js";

export interface OpenCodeProviderCatalogResponse {
  all: Provider[];
  default: Record<string, string>;
  connected: string[];
}

export interface OpenCodePromptInput {
  sessionID: string;
  messageID?: string;
  text: string;
  model?: OpenCodeNativeModelRef;
  variant?: string;
}

export interface OpenCodeCommandInput {
  sessionID: string;
  command: string;
  arguments: string;
  model?: OpenCodeNativeModelRef;
  variant?: string;
}

export interface OpenCodeTransportListener {
  onEvent(event: Event): void;
  onFault(error: OpenCodeTransportError): void;
}

export interface OpenCodeTransport {
  readonly cwd: string;
  readonly stderrTail?: string;

  health(): Promise<{ healthy: true; version: string }>;
  providers(): Promise<OpenCodeProviderCatalogResponse>;
  commands(): Promise<Command[]>;
  createSession(input?: {
    model?: OpenCodeNativeModelRef;
    variant?: string;
    permission?: PermissionRuleset;
  }): Promise<Session>;
  deleteSession(sessionID: string): Promise<void>;
  getSession(sessionID: string): Promise<Session>;
  getPaths(): Promise<{ directory: string; worktree: string }>;
  updateSessionMetadata(sessionID: string, metadata: Record<string, unknown>): Promise<Session>;
  updateSessionPermission(sessionID: string, permission: PermissionRuleset): Promise<Session>;
  getMessages(sessionID: string): Promise<OpenCodeMessageWithParts[]>;
  getStatus(sessionID: string): Promise<SessionStatus>;
  getDiff(sessionID: string, messageID?: string): Promise<SnapshotFileDiff[]>;
  forkSession(sessionID: string, messageID?: string): Promise<Session>;
  revertSession(sessionID: string, messageID: string): Promise<Session>;
  unrevertSession(sessionID: string): Promise<Session>;
  promptAsync(input: OpenCodePromptInput): Promise<void>;
  executeCommand(
    input: OpenCodeCommandInput,
  ): Promise<OpenCodeMessageWithParts & { info: AssistantMessage }>;
  summarize(sessionID: string, model?: OpenCodeNativeModelRef): Promise<void>;
  abort(sessionID: string): Promise<void>;
  listQuestions(): Promise<QuestionRequest[]>;
  replyQuestion(requestID: string, answers: QuestionAnswer[]): Promise<void>;
  rejectQuestion(requestID: string): Promise<void>;
  listPermissions(): Promise<PermissionRequest[]>;
  replyPermission(requestID: string, reply: "once" | "reject"): Promise<void>;
  subscribe(listener: OpenCodeTransportListener): Promise<void>;
  close(): Promise<void>;
}

export type OpenCodeTransportErrorCode =
  "notInstalled" | "authenticationRequired" | "unavailable" | "protocolError" | "processExited";

export class OpenCodeTransportError extends Error {
  constructor(
    readonly code: OpenCodeTransportErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "OpenCodeTransportError";
  }
}
