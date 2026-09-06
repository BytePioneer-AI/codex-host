import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";

import { sanitizeDiagnosticTail } from "@codexhost/harness-adapter";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  ndJsonStream,
  type Client,
  type InitializeResponse,
  type LoadSessionResponse,
  type NewSessionResponse,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";

import { KiroExecutableError, kiroInvocation, resolveKiroExecutable } from "./command.js";
import type { KiroUserInputParams, KiroUserInputResult } from "./projection.js";

export type KiroTransportFaultKind =
  | "notInstalled"
  | "authenticationRequired"
  | "unavailable"
  | "protocolError"
  | "processExited"
  | "checkpointNotFound";

export class KiroTransportError extends Error {
  readonly diagnostic: string | undefined;

  constructor(
    readonly kind: KiroTransportFaultKind,
    message: string,
    options?: ErrorOptions & { diagnostic?: string },
  ) {
    super(message, options);
    this.diagnostic = options?.diagnostic;
    this.name = "KiroTransportError";
  }
}

export type KiroTransportEvent =
  | { type: "user.text"; text: string; messageId?: string | undefined; metadata?: Record<string, unknown> | undefined }
  | { type: "agent.text"; text: string; messageId?: string | undefined; metadata?: Record<string, unknown> | undefined }
  | { type: "agent.thought"; text: string; messageId?: string | undefined; metadata?: Record<string, unknown> | undefined }
  | {
      type: "tool.call";
      callId: string;
      title: string;
      name?: string | undefined;
      kind?: string | undefined;
      status?: string | undefined;
      rawInput?: unknown;
      rawOutput?: unknown;
      content?: unknown[] | undefined;
      metadata?: Record<string, unknown> | undefined;
    }
  | {
      type: "tool.update";
      callId: string;
      title?: string | null | undefined;
      name?: string | null | undefined;
      kind?: string | null | undefined;
      status?: string | null | undefined;
      rawInput?: unknown;
      rawOutput?: unknown;
      content?: unknown[] | null | undefined;
      metadata?: Record<string, unknown> | undefined;
    }
  | { type: "usage"; update: SessionUpdate; metadata?: Record<string, unknown> | undefined }
  | {
      type: "compaction.completed";
      outcome: "succeeded" | "failed";
      metadata?: Record<string, unknown> | undefined;
    }
  | {
      type: "turn.completed";
      nativeTurnKey: string;
      stopReason: string;
      metadata?: Record<string, unknown> | undefined;
    };

export interface KiroAcpTransportOptions {
  cwd: string;
  command?: string | undefined;
  environment?: NodeJS.ProcessEnv | undefined;
  commandTimeoutMs?: number | undefined;
  closeTimeoutMs?: number | undefined;
  onFault?: ((error: KiroTransportError) => void) | undefined;
}

export interface KiroForkOpenInput {
  kind: "fork";
  sourceSessionId: string;
  sourceCwd: string;
  checkpointMessageId: string;
  modelId?: string | undefined;
  autopilot?: "on" | "off" | undefined;
}

export interface KiroRollbackOpenInput {
  kind: "rollbackLastTurn";
  sourceSessionId: string;
  sourceCwd: string;
  checkpointMessageId: string;
  modelId?: string | undefined;
  autopilot?: "on" | "off" | undefined;
}

export type KiroOpenInput =
  | { kind: "create"; modelId?: string | undefined; autopilot?: "on" | "off" | undefined }
  | { kind: "resume"; sessionId: string; modelId?: string | undefined; autopilot?: "on" | "off" | undefined }
  | KiroForkOpenInput
  | KiroRollbackOpenInput;

export interface KiroOpenResult {
  initialize: InitializeResponse;
  session: NewSessionResponse | LoadSessionResponse;
  sessionId: string;
  configOptions?: unknown[] | undefined;
  replay: KiroTransportEvent[];
}

interface ActivePrompt {
  onEvent(event: KiroTransportEvent): void;
  onPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  onQuestion(params: KiroUserInputParams): Promise<KiroUserInputResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function classifyStartupError(error: unknown): KiroTransportError {
  if (error instanceof KiroTransportError) return error;
  if (error instanceof KiroExecutableError) {
    return new KiroTransportError("notInstalled", error.message, { cause: error });
  }
  const text = errorText(error).toLowerCase();
  if (
    text.includes("auth_required") ||
    text.includes("authentication") ||
    text.includes("not logged in") ||
    text.includes("sign in") ||
    text.includes("unauthorized")
  ) {
    return new KiroTransportError(
      "authenticationRequired",
      "Kiro CLI authentication is required",
      { cause: error },
    );
  }
  return new KiroTransportError("unavailable", "Kiro CLI could not start", { cause: error });
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, operation: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new KiroTransportError("unavailable", `${operation} timed out`)),
        milliseconds,
      );
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return Promise.race([
    new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

function signalProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (!isRecord(error) || error.code !== "ESRCH") throw error;
  }
}

export class KiroAcpTransport {
  readonly #options: KiroAcpTransportOptions;
  readonly #commandTimeoutMs: number;
  readonly #closeTimeoutMs: number;
  #activePrompt: ActivePrompt | null = null;
  #child: ChildProcessWithoutNullStreams | null = null;
  #closed = false;
  #closing = false;
  #connection: ClientSideConnection | null = null;
  #initialize: InitializeResponse | null = null;
  #replay: KiroTransportEvent[] | null = null;
  #sessionId: string | null = null;
  #stderrTail = "";

  constructor(options: KiroAcpTransportOptions) {
    this.#options = options;
    this.#commandTimeoutMs = options.commandTimeoutMs ?? 30_000;
    this.#closeTimeoutMs = options.closeTimeoutMs ?? 2_000;
  }

  get sessionId(): string {
    if (!this.#sessionId) throw new Error("Kiro ACP Session is not open");
    return this.#sessionId;
  }

  get stderrTail(): string {
    return this.#stderrTail;
  }

  async inspect(): Promise<InitializeResponse> {
    if (this.#sessionId) throw new Error("Kiro ACP inspection cannot reuse an open Session");
    try {
      const initialize = await this.#ensureInitialized();
      return initialize;
    } catch (error) {
      const classified = classifyStartupError(error);
      await this.close().catch(() => undefined);
      throw classified;
    }
  }

  async open(input: KiroOpenInput): Promise<KiroOpenResult> {
    if (this.#sessionId || this.#closed) {
      throw new Error("Kiro ACP Transport cannot be opened twice");
    }
    try {
      const initialize = await this.#ensureInitialized();
      const connection = this.#connection;
      if (!connection) throw new KiroTransportError("unavailable", "Kiro ACP is unavailable");

      this.#replay = input.kind === "resume" || input.kind === "fork" || input.kind === "rollbackLastTurn" ? [] : null;

      let session: NewSessionResponse | LoadSessionResponse;
      let sessionId: string;
      let configOptions: unknown[] | undefined;

      if (input.kind === "create") {
        const created = await withTimeout(
          connection.newSession({
            cwd: this.#options.cwd,
            mcpServers: [],
          }),
          this.#commandTimeoutMs,
          "Kiro Session creation",
        );
        session = created;
        sessionId = created.sessionId;
        configOptions = (created as { configOptions?: unknown[] }).configOptions;

        // Apply initial config options if provided
        if (input.modelId) {
          await this.#setConfigOptionOnSession(connection, sessionId, "model", input.modelId);
        }
        if (input.autopilot) {
          await this.#setConfigOptionOnSession(connection, sessionId, "autopilot", input.autopilot);
        }
      } else if (input.kind === "fork" || input.kind === "rollbackLastTurn") {
        const forked = await this.#forkSession({
          sourceSessionId: input.sourceSessionId,
          targetCwd: this.#options.cwd,
          checkpointMessageId: input.checkpointMessageId,
        });
        sessionId = forked.sessionId;

        session = await withTimeout(
          connection.loadSession({
            cwd: this.#options.cwd,
            mcpServers: [],
            sessionId,
          }),
          this.#commandTimeoutMs,
          "Kiro Fork Session load",
        );
        configOptions = (session as { configOptions?: unknown[] }).configOptions;

        // Crucial: Child session resets config to defaults; restore model and autopilot!
        if (input.modelId) {
          await this.#setConfigOptionOnSession(connection, sessionId, "model", input.modelId);
        }
        if (input.autopilot) {
          await this.#setConfigOptionOnSession(connection, sessionId, "autopilot", input.autopilot);
        }
      } else {
        session = await withTimeout(
          connection.loadSession({
            cwd: this.#options.cwd,
            mcpServers: [],
            sessionId: input.sessionId,
          }),
          this.#commandTimeoutMs,
          "Kiro Session load",
        );
        sessionId = input.sessionId;
        configOptions = (session as { configOptions?: unknown[] }).configOptions;

        if (input.modelId) {
          await this.#setConfigOptionOnSession(connection, sessionId, "model", input.modelId);
        }
        if (input.autopilot) {
          await this.#setConfigOptionOnSession(connection, sessionId, "autopilot", input.autopilot);
        }
      }

      if (typeof sessionId !== "string" || sessionId.length === 0) {
        throw new KiroTransportError("protocolError", "Kiro ACP returned no Session identity");
      }

      this.#sessionId = sessionId;
      const replay = this.#replay ?? [];
      this.#replay = null;

      return {
        initialize,
        session,
        sessionId,
        ...(configOptions ? { configOptions } : {}),
        replay,
      };
    } catch (error) {
      const classified = classifyStartupError(error);
      await this.close().catch(() => undefined);
      throw classified;
    }
  }

  async setConfigOption(configId: string, value: string): Promise<unknown> {
    const connection = this.#connection;
    if (!connection || !this.#sessionId || this.#closed || this.#closing) {
      throw new KiroTransportError("unavailable", "Kiro ACP Session is unavailable");
    }
    return this.#setConfigOptionOnSession(connection, this.#sessionId, configId, value);
  }

  async #setConfigOptionOnSession(
    connection: ClientSideConnection,
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<unknown> {
    try {
      return await withTimeout(
        connection.setSessionConfigOption({
          sessionId,
          configId,
          value,
        }),
        this.#commandTimeoutMs,
        `Kiro set_config_option (${configId})`,
      );
    } catch (error) {
      throw new KiroTransportError("unavailable", `Failed to set ${configId} config option`, {
        cause: error,
      });
    }
  }

  async #forkSession(params: {
    sourceSessionId: string;
    targetCwd: string;
    checkpointMessageId: string;
  }): Promise<{ sessionId: string }> {
    const connection = this.#connection;
    if (!connection) throw new KiroTransportError("unavailable", "Kiro ACP is unavailable");
    try {
      const raw = await withTimeout(
        connection.request("session/fork", {
          sessionId: params.sourceSessionId,
          cwd: params.targetCwd,
          _meta: {
            kiro: {
              messageId: params.checkpointMessageId,
            },
          },
        }),
        this.#commandTimeoutMs,
        "Kiro Session fork",
      );

      if (!isRecord(raw) || typeof raw.sessionId !== "string" || raw.sessionId.length === 0) {
        throw new KiroTransportError("protocolError", "Kiro Fork returned no valid sessionId");
      }
      if (raw.sessionId === params.sourceSessionId) {
        throw new KiroTransportError("protocolError", "Kiro Fork returned the source Session identity");
      }
      return { sessionId: raw.sessionId };
    } catch (error) {
      if (error instanceof KiroTransportError) throw error;
      if (error instanceof RequestError) {
        if (error.code === -32601) {
          throw new KiroTransportError("protocolError", "Kiro ACP Method Not Found: session/fork", {
            cause: error,
          });
        }
        if (error.message.includes("not found") || error.message.includes("message")) {
          throw new KiroTransportError("checkpointNotFound", error.message, { cause: error });
        }
      }
      throw new KiroTransportError("unavailable", "Kiro Native Fork failed", { cause: error });
    }
  }

  async runTurn(
    text: string,
    onEvent: ActivePrompt["onEvent"],
    onPermission: ActivePrompt["onPermission"],
    onQuestion: ActivePrompt["onQuestion"],
  ): Promise<PromptResponse> {
    const connection = this.#connection;
    if (!connection || !this.#sessionId || this.#closed || this.#closing) {
      throw new KiroTransportError("unavailable", "Kiro ACP Session is unavailable");
    }
    if (this.#activePrompt) throw new Error("Kiro ACP Session already has an active Prompt");

    const active: ActivePrompt = { onEvent, onPermission, onQuestion };
    this.#activePrompt = active;
    try {
      return await connection.prompt({
        sessionId: this.#sessionId,
        prompt: [{ type: "text", text }],
      });
    } finally {
      if (this.#activePrompt === active) this.#activePrompt = null;
    }
  }

  async cancel(): Promise<void> {
    const connection = this.#connection;
    if (!connection || !this.#sessionId || this.#closed || this.#closing) return;
    try {
      await connection.cancel({ sessionId: this.#sessionId });
    } catch {
      // Cancellation is best-effort notification
    }
  }

  async compact(): Promise<unknown> {
    const connection = this.#connection;
    if (!connection || !this.#sessionId || this.#closed || this.#closing) {
      throw new KiroTransportError("unavailable", "Kiro ACP Session is unavailable");
    }
    try {
      return await withTimeout(
        connection.request("_kiro/session/compact", {
          sessionId: this.#sessionId,
        }),
        this.#commandTimeoutMs,
        "Kiro session compact",
      );
    } catch (error) {
      throw new KiroTransportError("unavailable", "Kiro context compaction failed", {
        cause: error,
      });
    }
  }

  async sendExtensionRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    const connection = this.#connection;
    if (!connection || !this.#sessionId || this.#closed || this.#closing) {
      throw new KiroTransportError("unavailable", "Kiro ACP Session is unavailable");
    }
    return withTimeout(
      connection.request(method, params),
      this.#commandTimeoutMs,
      `Kiro request: ${method}`,
    );
  }

  async #ensureInitialized(): Promise<InitializeResponse> {
    if (this.#initialize) return this.#initialize;
    if (this.#child || this.#closed) throw new Error("Kiro ACP Transport cannot be started twice");

    const executable = resolveKiroExecutable({
      ...(this.#options.command ? { command: this.#options.command } : {}),
      environment: this.#options.environment ?? process.env,
    });
    const invocation = kiroInvocation(executable);

    const child = spawn(invocation.command, invocation.arguments, {
      cwd: this.#options.cwd,
      env: { ...process.env, ...this.#options.environment },
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    this.#child = child;

    child.stderr.on("data", (chunk: Buffer | string) => {
      this.#stderrTail = sanitizeDiagnosticTail(`${this.#stderrTail}${chunk.toString()}`);
    });

    await withTimeout(
      new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      }),
      this.#commandTimeoutMs,
      "Kiro CLI startup",
    );

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );

    const connection = new ClientSideConnection(
      () =>
        ({
          sessionUpdate: (params) => this.#handleUpdate(params),
          requestPermission: (params) => this.#handlePermission(params),
          extMethod: (method, params) => this.#handleExtMethod(method, params),
          extNotification: () => this.#handleExtNotification(),
        }) satisfies Client,
      stream,
    );
    this.#connection = connection;

    child.once("error", (error) =>
      this.#fault(new KiroTransportError("processExited", error.message)),
    );
    child.once("exit", (code, signal) => {
      if (!this.#closing && !this.#closed) {
        this.#fault(
          new KiroTransportError(
            "processExited",
            `Kiro ACP exited (code=${code}, signal=${signal})`,
          ),
        );
      }
    });

    const initialize = await withTimeout(
      connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          _meta: {
            kiro: {
              userInput: true,
              requirementsAnalysis: true,
              specPhaseCheckpoints: true,
            },
          },
        },
        clientInfo: { name: "codexhost", version: "0.1.6" },
      }),
      this.#commandTimeoutMs,
      "Kiro ACP initialize",
    );

    if (initialize.protocolVersion !== PROTOCOL_VERSION) {
      throw new KiroTransportError(
        "protocolError",
        `Kiro ACP negotiated unsupported protocol version ${initialize.protocolVersion}`,
      );
    }
    this.#initialize = initialize;
    return initialize;
  }

  #handleUpdate(params: SessionNotification): void {
    const update = params.update;
    const meta = isRecord(update) && isRecord((update as Record<string, unknown>)._meta)
      ? ((update as Record<string, unknown>)._meta as Record<string, unknown>)
      : undefined;
    const kiroMeta = meta && isRecord(meta.kiro) ? meta.kiro : undefined;

    let event: KiroTransportEvent | null = null;

    if (update.sessionUpdate === "agent_message_chunk") {
      const isReplay = Boolean(kiroMeta?.replay);
      const text = update.content?.type === "text" ? update.content.text : "";
      if (text) {
        event = {
          type: "agent.text",
          text,
          messageId: typeof kiroMeta?.messageId === "string" ? kiroMeta.messageId : undefined,
          metadata: { isReplay },
        };
      }
    } else if (update.sessionUpdate === "user_message_chunk") {
      const text = update.content?.type === "text" ? update.content.text : "";
      event = {
        type: "user.text",
        text,
        messageId: typeof kiroMeta?.messageId === "string" ? kiroMeta.messageId : undefined,
      };
    } else if (update.sessionUpdate === "tool_call") {
      event = {
        type: "tool.call",
        callId: update.toolCallId,
        title: update.title,
        name: update.name ?? undefined,
        kind: update.kind ?? undefined,
        status: update.status ?? undefined,
        rawInput: update.rawInput,
        rawOutput: update.rawOutput,
        content: update.content,
        metadata: meta,
      };
    } else if (update.sessionUpdate === "tool_call_update") {
      event = {
        type: "tool.update",
        callId: update.toolCallId,
        title: update.title,
        name: update.name ?? undefined,
        kind: update.kind ?? undefined,
        status: update.status ?? undefined,
        rawInput: update.rawInput,
        rawOutput: update.rawOutput,
        content: update.content,
        metadata: meta,
      };
    } else if (update.sessionUpdate === "session_info_update") {
      if (kiroMeta?.kind === "summarization_completed") {
        const summarization = isRecord(kiroMeta.summarization)
          ? (kiroMeta.summarization as Record<string, unknown>)
          : undefined;
        event = {
          type: "compaction.completed",
          outcome: summarization?.status === "success" ? "succeeded" : "failed",
          metadata: meta,
        };
      } else {
        event = {
          type: "usage",
          update,
          metadata: meta,
        };
      }
    }

    if (event) {
      if (this.#replay !== null) {
        this.#replay.push(event);
      } else if (this.#activePrompt) {
        this.#activePrompt.onEvent(event);
      }
    }
  }

  async #handlePermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (this.#activePrompt) {
      return this.#activePrompt.onPermission(request);
    }
    return { outcome: { outcome: "cancelled" } };
  }

  async #handleExtMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (method === "_kiro/userInput") {
      if (this.#activePrompt) {
        const result = await this.#activePrompt.onQuestion(params as unknown as KiroUserInputParams);
        return result as unknown as Record<string, unknown>;
      }
      return { action: "dismissed" };
    }
    throw new Error(`Unsupported Kiro client extension method: ${method}`);
  }

  async #handleExtNotification(): Promise<void> {
    // Ignored extension notifications
  }

  #fault(error: KiroTransportError): void {
    if (this.#closed || this.#closing) return;
    this.#options.onFault?.(error);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#closing = true;

    try {
      if (this.#child) {
        const child = this.#child;
        this.#child = null;

        if (child.stdin && !child.stdin.destroyed) {
          child.stdin.end();
        }

        const exited = await waitForExit(child, this.#closeTimeoutMs);
        if (!exited) {
          signalProcessTree(child, "SIGKILL");
          await waitForExit(child, 1_000);
        }
      }
    } finally {
      this.#connection = null;
      this.#closing = false;
    }
  }
}
