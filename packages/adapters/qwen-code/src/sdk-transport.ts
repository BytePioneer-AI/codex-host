import { randomUUID } from "node:crypto";

import {
  isSDKAssistantMessage,
  isSDKPartialAssistantMessage,
  isSDKResultMessage,
  isSDKSystemMessage,
  isSDKUserMessage,
  query,
  type CanUseTool,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@qwen-code/sdk";
import type { HarnessPermissionModeId } from "@codexhost/shared-contracts";

import { QwenCodeExecutableError, resolveQwenExecutable } from "./command.js";
import { decodeQwenCodePermissionModeId } from "./permission-modes.js";

export type QwenCodeTransportFaultKind =
  | "notInstalled"
  | "authenticationRequired"
  | "unavailable"
  | "protocolError"
  | "processExited";

export class QwenCodeTransportError extends Error {
  readonly diagnostic: string | undefined;

  constructor(
    readonly kind: QwenCodeTransportFaultKind,
    message: string,
    options?: ErrorOptions & { diagnostic?: string },
  ) {
    super(message, options);
    this.diagnostic = options?.diagnostic;
    this.name = "QwenCodeTransportError";
  }
}

export type QwenCodeTransportEvent =
  | { type: "agent.text"; text: string }
  | { type: "agent.thought"; text: string }
  | {
      type: "tool.call";
      callId: string;
      title: string;
      name?: string;
      kind?: string;
      content?: unknown[] | null;
      rawInput?: unknown;
      rawOutput?: unknown;
      status?: "completed" | "failed";
    }
  | {
      type: "tool.update";
      callId: string;
      content?: unknown[] | null;
      rawInput?: unknown;
      rawOutput?: unknown;
      status?: "completed" | "failed";
    }
  | { type: "usage"; metadata: Record<string, unknown> };

export interface QwenCodePermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
}

export interface QwenCodePermissionResponse {
  behavior: "allow" | "deny";
  updatedInput?: Record<string, unknown>;
}

export interface QwenCodeSdkTransportOptions {
  cwd: string;
  command?: string;
  environment?: NodeJS.ProcessEnv;
  onFault?: (error: QwenCodeTransportError) => void;
  queryFactory?: typeof query;
}

export interface QwenCodeOpenInput {
  kind: "create" | "resume";
  sessionId?: string;
  model?: string;
  permissionMode: HarnessPermissionModeId;
}

export interface QwenCodeOpenResult {
  sessionId: string;
  models: unknown;
  resumed: boolean;
}

interface ActiveTurn {
  onEvent(event: QwenCodeTransportEvent): void;
  onPermission(request: QwenCodePermissionRequest): Promise<QwenCodePermissionResponse>;
  reject(error: unknown): void;
  resolve(result: { status: "succeeded" | "failed" | "cancelled" }): void;
}

class PushableInput implements AsyncIterable<SDKUserMessage> {
  #closed = false;
  #queue: SDKUserMessage[] = [];
  #waiters: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];

  push(value: SDKUserMessage): void {
    if (this.#closed) throw new Error("Qwen Code SDK input is closed");
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.#queue.push(value);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const value = this.#queue.shift();
        if (value) return Promise.resolve({ done: false, value });
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function classifyError(error: unknown): QwenCodeTransportError {
  if (error instanceof QwenCodeTransportError) return error;
  if (error instanceof QwenCodeExecutableError) {
    return new QwenCodeTransportError("notInstalled", error.message, { cause: error });
  }
  const text = errorText(error);
  const lower = text.toLowerCase();
  if (
    lower.includes("auth_required") ||
    lower.includes("authentication") ||
    lower.includes("not logged in") ||
    lower.includes("sign in")
  ) {
    return new QwenCodeTransportError(
      "authenticationRequired",
      "Qwen Code CLI authentication is required",
      { cause: error },
    );
  }
  return new QwenCodeTransportError("unavailable", `Qwen Code SDK failed: ${text}`, { cause: error });
}

function rawToolOutput(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .flatMap((block) => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []))
    .join("\n");
  return text.length > 0 ? text : undefined;
}

function toolKind(name: string): string | undefined {
  return name === "run_shell_command" || name === "Bash" ? "execute" : undefined;
}

export class QwenCodeSdkTransport {
  readonly #options: QwenCodeSdkTransportOptions;
  #active: ActiveTurn | null = null;
  #closed = false;
  #input: PushableInput | null = null;
  #modelId: string | undefined;
  #query: Query | null = null;
  #sessionId: string | null = null;

  constructor(options: QwenCodeSdkTransportOptions) {
    this.#options = options;
  }

  get sessionId(): string {
    if (!this.#sessionId) throw new Error("Qwen Code SDK Session is not open");
    return this.#sessionId;
  }

  async inspect(): Promise<{ models: unknown }> {
    await this.#start({ kind: "create", permissionMode: "default" as HarnessPermissionModeId });
    try {
      return { models: await this.#models() };
    } finally {
      await this.close();
    }
  }

  async open(input: QwenCodeOpenInput): Promise<QwenCodeOpenResult> {
    await this.#start(input);
    return {
      sessionId: this.sessionId,
      models: await this.#models(),
      resumed: input.kind === "resume",
    };
  }

  async runTurn(
    text: string,
    onEvent: ActiveTurn["onEvent"],
    onPermission: ActiveTurn["onPermission"],
  ): Promise<{ status: "succeeded" | "failed" | "cancelled" }> {
    if (!this.#input || !this.#sessionId || this.#closed) {
      throw new QwenCodeTransportError("unavailable", "Qwen Code SDK Session is unavailable");
    }
    if (this.#active) throw new Error("Qwen Code SDK Session already has an active Prompt");
    return new Promise((resolve, reject) => {
      this.#active = { onEvent, onPermission, resolve, reject };
      try {
        this.#input?.push({
          type: "user",
          session_id: this.#sessionId as string,
          message: { role: "user", content: text },
          parent_tool_use_id: null,
        });
      } catch (error) {
        this.#active = null;
        reject(error);
      }
    });
  }

  async setModel(nativeModelId: string): Promise<void> {
    if (!this.#query || this.#closed) {
      throw new QwenCodeTransportError("unavailable", "Qwen Code SDK Session is unavailable");
    }
    await this.#query.setModel(nativeModelId);
    this.#modelId = nativeModelId;
  }

  async setPermissionMode(permissionModeId: HarnessPermissionModeId): Promise<void> {
    if (!this.#query || this.#closed) {
      throw new QwenCodeTransportError("unavailable", "Qwen Code SDK Session is unavailable");
    }
    await this.#query.setPermissionMode(decodeQwenCodePermissionModeId(permissionModeId));
  }

  async cancel(): Promise<void> {
    if (!this.#query || !this.#active) {
      throw new Error("Qwen Code SDK Session has no cancellable operation");
    }
    await this.#query.interrupt();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#input?.close();
    const active = this.#active;
    this.#active = null;
    active?.resolve({ status: "cancelled" });
    await this.#query?.close().catch(() => undefined);
  }

  async #start(input: QwenCodeOpenInput): Promise<void> {
    if (this.#query || this.#closed) throw new Error("Qwen Code SDK Transport cannot be opened twice");
    const resumeSessionId = input.sessionId;
    if (input.kind === "resume" && !resumeSessionId) {
      throw new QwenCodeTransportError("protocolError", "Qwen Code resume requires a Session identity");
    }
    const executable = resolveQwenExecutable({
      ...(this.#options.command ? { command: this.#options.command } : {}),
      environment: this.#options.environment ?? process.env,
    });
    const inputStream = new PushableInput();
    const queryFactory = this.#options.queryFactory ?? query;
    const sessionId = input.kind === "resume" ? resumeSessionId! : randomUUID();
    const permissionMode = decodeQwenCodePermissionModeId(input.permissionMode);
    const environment = this.#environment();
    try {
      const session = queryFactory({
        prompt: inputStream,
        options: {
          cwd: this.#options.cwd,
          ...(input.model ? { model: input.model } : {}),
          ...(environment ? { env: environment } : {}),
          includePartialMessages: true,
          pathToQwenExecutable: executable,
          permissionMode,
          ...(input.kind === "resume" ? { resume: resumeSessionId! } : { sessionId }),
          canUseTool: this.#canUseTool,
        },
      });
      this.#input = inputStream;
      this.#query = session;
      this.#sessionId = sessionId;
      void this.#consume(session);
      await session.initialized;
      const initializedSessionId = session.getSessionId();
      if (!initializedSessionId) {
        throw new QwenCodeTransportError("protocolError", "Qwen Code SDK did not return a Session identity");
      }
      this.#sessionId = initializedSessionId;
    } catch (error) {
      await this.close();
      throw classifyError(error);
    }
  }

  #environment(): Record<string, string> | undefined {
    const environment = this.#options.environment;
    if (!environment) return undefined;
    return Object.fromEntries(
      Object.entries(environment).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  }

  #canUseTool: CanUseTool = async (toolName, input) => {
    const active = this.#active;
    if (!active) return { behavior: "deny", message: "No active codexhost Turn" };
    const response = await active.onPermission({ toolName, input });
    if (response.behavior === "allow") {
      return { behavior: "allow", updatedInput: response.updatedInput ?? input } satisfies PermissionResult;
    }
    return { behavior: "deny", message: "Denied by user" } satisfies PermissionResult;
  };

  async #models(): Promise<unknown> {
    const session = this.#query;
    if (!session) throw new QwenCodeTransportError("unavailable", "Qwen Code SDK Session is unavailable");
    const response = await session.getAvailableModels();
    if (!isRecord(response) || !Array.isArray(response.models)) {
      throw new QwenCodeTransportError("protocolError", "Qwen Code SDK returned an invalid Model catalog");
    }
    const availableModels = response.models.flatMap((candidate) => {
      if (!isRecord(candidate) || typeof candidate.id !== "string" || candidate.id.length === 0) return [];
      return [
        {
          modelId: candidate.id,
          name:
            typeof candidate.label === "string" && candidate.label.length > 0
              ? candidate.label
              : candidate.id,
          _meta:
            typeof candidate.contextWindowSize === "number"
              ? { contextLimit: candidate.contextWindowSize }
              : undefined,
        },
      ];
    });
    const currentModelId = this.#modelId ?? availableModels[0]?.modelId;
    if (!currentModelId || availableModels.length === 0) {
      throw new QwenCodeTransportError("protocolError", "Qwen Code SDK returned no selectable Models");
    }
    return { currentModelId, availableModels };
  }

  async #consume(session: Query): Promise<void> {
    try {
      for await (const message of session) this.#message(message);
    } catch (error) {
      this.#fault(classifyError(error));
    }
  }

  #message(message: SDKMessage): void {
    if (isSDKSystemMessage(message)) {
      if (message.model) this.#modelId = message.model;
      return;
    }
    const active = this.#active;
    if (!active) return;
    if (isSDKPartialAssistantMessage(message)) {
      if (message.event.type !== "content_block_delta") return;
      if (message.event.delta.type === "text_delta" && message.event.delta.text.length > 0) {
        active.onEvent({ type: "agent.text", text: message.event.delta.text });
      } else if (
        message.event.delta.type === "thinking_delta" &&
        message.event.delta.thinking.length > 0
      ) {
        active.onEvent({ type: "agent.thought", text: message.event.delta.thinking });
      }
      return;
    }
    if (isSDKAssistantMessage(message)) {
      for (const block of message.message.content) {
        if (block.type !== "tool_use") continue;
        const kind = toolKind(block.name);
        active.onEvent({
          type: "tool.call",
          callId: block.id,
          title: block.name,
          name: block.name,
          ...(kind ? { kind } : {}),
          rawInput: block.input,
        });
      }
      return;
    }
    if (isSDKUserMessage(message)) {
      for (const block of typeof message.message.content === "string" ? [] : message.message.content) {
        if (block.type !== "tool_result") continue;
        active.onEvent({
          type: "tool.update",
          callId: block.tool_use_id,
          status: block.is_error ? "failed" : "completed",
          ...(rawToolOutput(block.content) ? { rawOutput: rawToolOutput(block.content) } : {}),
        });
      }
      return;
    }
    if (isSDKResultMessage(message)) {
      active.onEvent({ type: "usage", metadata: { usage: message.usage } });
      this.#active = null;
      active.resolve({
        status: message.is_error ? "failed" : "succeeded",
      });
    }
  }

  #fault(error: QwenCodeTransportError): void {
    if (this.#closed) return;
    const active = this.#active;
    this.#active = null;
    active?.reject(error);
    this.#options.onFault?.(error);
  }
}
