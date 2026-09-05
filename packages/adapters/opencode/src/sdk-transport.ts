import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import type {
  AssistantMessage,
  PermissionRuleset,
  QuestionAnswer,
  SessionStatus,
} from "@opencode-ai/sdk/v2";

import type { OpenCodeMessageWithParts } from "./history.js";
import type { OpenCodeNativeModelRef } from "./model-catalog.js";
import {
  OpenCodeTransportError,
  type OpenCodeCommandInput,
  type OpenCodePromptInput,
  type OpenCodeProviderCatalogResponse,
  type OpenCodeTransport,
  type OpenCodeTransportListener,
} from "./protocol.js";
import type { OpenCodeServerConnectionLike, OpenCodeServerOptions } from "./server-connection.js";

export {
  managedOpenCodeEnvironment,
  OpenCodeServerConnection,
  type OpenCodeServerConnectionLike,
  type OpenCodeServerDependencies,
  type OpenCodeServerOptions,
} from "./server-connection.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
const DEFAULT_RECONNECT_DELAY_MS = 500;
const DEFAULT_RECONNECT_ATTEMPTS = 3;

function classifySdkError(error: unknown, operation: string): OpenCodeTransportError {
  if (error instanceof OpenCodeTransportError) return error;
  const text = error instanceof Error ? error.message : String(error);
  const lower = text.toLowerCase();
  if (lower.includes("unauthorized") || lower.includes("authentication")) {
    return new OpenCodeTransportError(
      "authenticationRequired",
      `OpenCode ${operation} requires authentication`,
      { cause: error },
    );
  }
  return new OpenCodeTransportError("unavailable", `OpenCode ${operation} failed: ${text}`, {
    cause: error,
  });
}

function responseData<T>(response: { data: T | undefined; error: unknown }, operation: string): T {
  if (response.error !== undefined) throw classifySdkError(response.error, operation);
  if (!("data" in response) || response.data === undefined)
    throw new OpenCodeTransportError(
      "protocolError",
      `OpenCode ${operation} response did not contain data`,
    );
  return response.data as T;
}

function responseAccepted(response: { data: unknown; error: unknown }, operation: string): void {
  if (response.error !== undefined) throw classifySdkError(response.error, operation);
  if (!("data" in response))
    throw new OpenCodeTransportError(
      "protocolError",
      `OpenCode ${operation} response did not contain data`,
    );
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, operation: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new OpenCodeTransportError("unavailable", `${operation} timed out`)),
        milliseconds,
      );
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export class SdkOpenCodeTransport implements OpenCodeTransport {
  readonly cwd: string;
  readonly #commandTimeoutMs: number;
  readonly #connection: OpenCodeServerConnectionLike;
  readonly #reconnectAttempts: number;
  readonly #reconnectDelayMs: number;
  #abort: AbortController | null = null;
  #client: Promise<OpencodeClient> | null = null;
  #listener: OpenCodeTransportListener | null = null;
  #pump: Promise<void> | null = null;

  constructor(
    connection: OpenCodeServerConnectionLike,
    cwd: string,
    options: OpenCodeServerOptions = {},
  ) {
    this.#connection = connection;
    this.cwd = cwd;
    this.#commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.#reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.#reconnectAttempts = options.reconnectAttempts ?? DEFAULT_RECONNECT_ATTEMPTS;
  }

  get stderrTail(): string {
    return this.#connection.stderrTail;
  }

  async health() {
    const client = await this.#getClient();
    return responseData<{ healthy: true; version: string }>(
      await withTimeout(client.global.health(), this.#commandTimeoutMs, "OpenCode health check"),
      "health check",
    );
  }

  async providers(): Promise<OpenCodeProviderCatalogResponse> {
    const client = await this.#getClient();
    return responseData(
      await withTimeout(client.provider.list(), this.#commandTimeoutMs, "OpenCode Provider list"),
      "Provider list",
    );
  }

  async commands() {
    const client = await this.#getClient();
    return responseData(
      await withTimeout(client.command.list(), this.#commandTimeoutMs, "OpenCode Command list"),
      "Command list",
    );
  }

  async createSession(
    input: {
      model?: OpenCodeNativeModelRef;
      variant?: string;
      permission?: PermissionRuleset;
    } = {},
  ) {
    const client = await this.#getClient();
    return responseData(
      await withTimeout(
        client.session.create({
          ...(input.model
            ? {
                model: {
                  id: input.model.modelID,
                  providerID: input.model.providerID,
                  ...(input.variant ? { variant: input.variant } : {}),
                },
              }
            : {}),
          ...(input.permission ? { permission: input.permission } : {}),
        }),
        this.#commandTimeoutMs,
        "OpenCode Session create",
      ),
      "Session create",
    );
  }

  async deleteSession(sessionID: string): Promise<void> {
    const client = await this.#getClient();
    responseData(
      await withTimeout(
        client.session.delete({ sessionID }),
        this.#commandTimeoutMs,
        "OpenCode Session delete",
      ),
      "Session delete",
    );
  }

  async getSession(sessionID: string) {
    const client = await this.#getClient();
    return responseData(
      await withTimeout(
        client.session.get({ sessionID }),
        this.#commandTimeoutMs,
        "OpenCode Session read",
      ),
      "Session read",
    );
  }

  async getPaths() {
    const client = await this.#getClient();
    return responseData(
      await withTimeout(client.path.get(), this.#commandTimeoutMs, "OpenCode Path read"),
      "Path read",
    );
  }

  async updateSessionMetadata(sessionID: string, metadata: Record<string, unknown>) {
    const client = await this.#getClient();
    return responseData(
      await withTimeout(
        client.session.update({ sessionID, metadata }),
        this.#commandTimeoutMs,
        "OpenCode Session metadata update",
      ),
      "Session metadata update",
    );
  }

  async updateSessionPermission(sessionID: string, permission: PermissionRuleset) {
    const client = await this.#getClient();
    return responseData(
      await withTimeout(
        client.session.update({ sessionID, permission }),
        this.#commandTimeoutMs,
        "OpenCode Session permission update",
      ),
      "Session permission update",
    );
  }

  async getMessages(sessionID: string): Promise<OpenCodeMessageWithParts[]> {
    const client = await this.#getClient();
    return responseData(
      await withTimeout(
        client.session.messages({ sessionID }),
        this.#commandTimeoutMs,
        "OpenCode transcript read",
      ),
      "transcript read",
    );
  }

  async getStatus(sessionID: string) {
    const client = await this.#getClient();
    const statuses = responseData<Record<string, SessionStatus>>(
      await withTimeout(client.session.status(), this.#commandTimeoutMs, "OpenCode Session status"),
      "Session status",
    );
    return statuses[sessionID] ?? { type: "idle" as const };
  }

  async getDiff(sessionID: string, messageID?: string) {
    const client = await this.#getClient();
    return responseData(
      await withTimeout(
        client.session.diff({ sessionID, ...(messageID ? { messageID } : {}) }),
        this.#commandTimeoutMs,
        "OpenCode Session diff",
      ),
      "Session diff",
    );
  }

  async forkSession(sessionID: string, messageID?: string) {
    const client = await this.#getClient();
    return responseData(
      await withTimeout(
        client.session.fork({ sessionID, ...(messageID ? { messageID } : {}) }),
        this.#commandTimeoutMs,
        "OpenCode Session fork",
      ),
      "Session fork",
    );
  }

  async revertSession(sessionID: string, messageID: string) {
    const client = await this.#getClient();
    return responseData(
      await withTimeout(
        client.session.revert({ sessionID, messageID }),
        this.#commandTimeoutMs,
        "OpenCode Session revert",
      ),
      "Session revert",
    );
  }

  async unrevertSession(sessionID: string) {
    const client = await this.#getClient();
    return responseData(
      await withTimeout(
        client.session.unrevert({ sessionID }),
        this.#commandTimeoutMs,
        "OpenCode Session unrevert",
      ),
      "Session unrevert",
    );
  }

  async promptAsync(input: OpenCodePromptInput): Promise<void> {
    const client = await this.#getClient();
    responseAccepted(
      await withTimeout(
        client.session.promptAsync({
          sessionID: input.sessionID,
          ...(input.model ? { model: input.model } : {}),
          ...(input.variant ? { variant: input.variant } : {}),
          parts: [{ type: "text", text: input.text }],
        }),
        this.#commandTimeoutMs,
        "OpenCode prompt admission",
      ),
      "prompt admission",
    );
  }

  async executeCommand(
    input: OpenCodeCommandInput,
  ): Promise<OpenCodeMessageWithParts & { info: AssistantMessage }> {
    const client = await this.#getClient();
    return responseData(
      await withTimeout(
        client.session.command({
          sessionID: input.sessionID,
          command: input.command,
          arguments: input.arguments,
          ...(input.model ? { model: `${input.model.providerID}/${input.model.modelID}` } : {}),
          ...(input.variant ? { variant: input.variant } : {}),
        }),
        this.#commandTimeoutMs,
        "OpenCode command admission",
      ),
      "command admission",
    );
  }

  async summarize(sessionID: string, model?: OpenCodeNativeModelRef): Promise<void> {
    const client = await this.#getClient();
    responseData(
      await withTimeout(
        client.session.summarize({
          sessionID,
          ...(model ? { providerID: model.providerID, modelID: model.modelID } : {}),
        }),
        this.#commandTimeoutMs,
        "OpenCode context compaction",
      ),
      "context compaction",
    );
  }

  async abort(sessionID: string): Promise<void> {
    const client = await this.#getClient();
    responseData(
      await withTimeout(
        client.session.abort({ sessionID }),
        this.#commandTimeoutMs,
        "OpenCode Turn abort",
      ),
      "Turn abort",
    );
  }

  async listQuestions() {
    const client = await this.#getClient();
    return responseData(
      await withTimeout(client.question.list(), this.#commandTimeoutMs, "OpenCode Question list"),
      "Question list",
    );
  }

  async replyQuestion(requestID: string, answers: QuestionAnswer[]): Promise<void> {
    const client = await this.#getClient();
    responseData(
      await withTimeout(
        client.question.reply({ requestID, answers }),
        this.#commandTimeoutMs,
        "OpenCode Question reply",
      ),
      "Question reply",
    );
  }

  async rejectQuestion(requestID: string): Promise<void> {
    const client = await this.#getClient();
    responseData(
      await withTimeout(
        client.question.reject({ requestID }),
        this.#commandTimeoutMs,
        "OpenCode Question reject",
      ),
      "Question reject",
    );
  }

  async listPermissions() {
    const client = await this.#getClient();
    return responseData(
      await withTimeout(
        client.permission.list(),
        this.#commandTimeoutMs,
        "OpenCode Permission list",
      ),
      "Permission list",
    );
  }

  async replyPermission(requestID: string, reply: "once" | "reject"): Promise<void> {
    const client = await this.#getClient();
    responseData(
      await withTimeout(
        client.permission.reply({ requestID, reply }),
        this.#commandTimeoutMs,
        "OpenCode Permission reply",
      ),
      "Permission reply",
    );
  }

  async subscribe(listener: OpenCodeTransportListener): Promise<void> {
    this.#listener = listener;
    this.#abort = new AbortController();
    this.#pump = this.#pumpEvents(this.#abort.signal);
    await Promise.resolve();
  }

  async close(): Promise<void> {
    this.#abort?.abort();
    await this.#pump?.catch(() => undefined);
    this.#abort = null;
    this.#pump = null;
    this.#listener = null;
    this.#client = null;
  }

  async #getClient(): Promise<OpencodeClient> {
    if (!this.#client) this.#client = this.#connection.client(this.cwd);
    try {
      return await this.#client;
    } catch (error) {
      this.#client = null;
      throw error;
    }
  }

  async #pumpEvents(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      try {
        const client = await this.#getClient();
        const events = await client.event.subscribe(undefined, { signal });
        let connectedThisAttempt = false;
        for await (const event of events.stream) {
          if (signal.aborted) return;
          if (event.type === "server.connected") {
            connectedThisAttempt = true;
            failures = 0;
          }
          this.#listener?.onEvent(event);
        }
        if (signal.aborted) return;
        if (!connectedThisAttempt) {
          throw new OpenCodeTransportError(
            "protocolError",
            "OpenCode event stream ended before server.connected",
          );
        }
        throw new OpenCodeTransportError("unavailable", "OpenCode event stream disconnected");
      } catch (error) {
        if (signal.aborted) return;
        failures += 1;
        if (failures > this.#reconnectAttempts) {
          this.#listener?.onFault(
            error instanceof OpenCodeTransportError
              ? error
              : new OpenCodeTransportError("processExited", "OpenCode event stream disconnected", {
                  cause: error,
                }),
          );
          return;
        }
        this.#client = null;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.#reconnectDelayMs);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
    }
  }
}
