import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";

import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type InitializeResponse,
  type NewSessionResponse,
  type LoadSessionResponse,
  type PermissionOption,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";

import { OpenCodeExecutableError, openCodeInvocation, resolveOpenCodeExecutable } from "./command.js";
import { openCodeDatabasePath, readOpenCodeHistory, type OpenCodeStoredSession } from "./opencode-storage.js";

export type OpenCodeTransportFaultKind =
  | "notInstalled"
  | "authenticationRequired"
  | "unavailable"
  | "protocolError"
  | "processExited";

export class OpenCodeTransportError extends Error {
  constructor(
    readonly kind: OpenCodeTransportFaultKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "OpenCodeTransportError";
  }
}

export type OpenCodeTransportEvent =
  | { type: "user.text"; text: string; messageId?: string; metadata?: Record<string, unknown> }
  | { type: "agent.text"; text: string; messageId?: string; metadata?: Record<string, unknown> }
  | { type: "agent.thought"; text: string; messageId?: string; metadata?: Record<string, unknown> }
  | {
      type: "tool.call";
      callId: string;
      title: string;
      name?: string;
      kind?: string;
      status?: string;
      rawInput?: unknown;
      rawOutput?: unknown;
      content?: unknown[];
      metadata?: Record<string, unknown>;
    }
  | {
      type: "tool.update";
      callId: string;
      title?: string | null;
      name?: string | null;
      kind?: string | null;
      status?: string | null;
      rawInput?: unknown;
      rawOutput?: unknown;
      content?: unknown[] | null;
      metadata?: Record<string, unknown>;
    }
  | { type: "usage"; update: SessionUpdate; metadata?: Record<string, unknown> };

export interface OpenCodePermissionRequest {
  request: RequestPermissionRequest;
  options: PermissionOption[];
}

export interface OpenCodeAcpTransportOptions {
  cwd: string;
  command?: string;
  environment?: NodeJS.ProcessEnv;
  commandTimeoutMs?: number;
  closeTimeoutMs?: number;
  onFault?: (error: OpenCodeTransportError) => void;
}

export interface OpenCodeOpenResult {
  initialize: InitializeResponse;
  session: NewSessionResponse | LoadSessionResponse;
  sessionId: string;
  history: OpenCodeStoredSession | null;
  signals?: unknown;
}

interface ActivePrompt {
  onEvent(event: OpenCodeTransportEvent): void;
  onPermission(request: OpenCodePermissionRequest): Promise<RequestPermissionResponse>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function classifyStartupError(error: unknown): OpenCodeTransportError {
  if (error instanceof OpenCodeTransportError) return error;
  if (error instanceof OpenCodeExecutableError) {
    return new OpenCodeTransportError("notInstalled", error.message, { cause: error });
  }
  const text = errorText(error).toLowerCase();
  if (
    text.includes("auth_required") ||
    text.includes("authentication") ||
    text.includes("not logged in") ||
    text.includes("sign in")
  ) {
    return new OpenCodeTransportError("authenticationRequired", "OpenCode CLI authentication is required", {
      cause: error,
    });
  }
  return new OpenCodeTransportError("unavailable", "OpenCode CLI could not start", { cause: error });
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, operation: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new OpenCodeTransportError("unavailable", `${operation} timed out`)),
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

function transportEvent(
  update: SessionUpdate,
  metadata?: Record<string, unknown>,
): OpenCodeTransportEvent | null {
  switch (update.sessionUpdate) {
    case "user_message_chunk":
    case "agent_message_chunk":
    case "agent_thought_chunk":
      if (update.content.type !== "text" || update.content.text.length === 0) return null;
      return {
        type:
          update.sessionUpdate === "user_message_chunk"
            ? "user.text"
            : update.sessionUpdate === "agent_message_chunk"
              ? "agent.text"
              : "agent.thought",
        text: update.content.text,
        ...(update.messageId ? { messageId: update.messageId } : {}),
      };
    case "tool_call":
      return {
        type: "tool.call",
        callId: update.toolCallId,
        title: update.title,
        ...(update.name ? { name: update.name } : {}),
        ...(update.kind ? { kind: update.kind } : {}),
        ...(update.status ? { status: update.status } : {}),
        ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
        ...(update.rawOutput !== undefined ? { rawOutput: update.rawOutput } : {}),
        ...(update.content ? { content: update.content } : {}),
      };
    case "tool_call_update":
      return {
        type: "tool.update",
        callId: update.toolCallId,
        ...(update.title !== undefined ? { title: update.title } : {}),
        ...(update.name !== undefined ? { name: update.name } : {}),
        ...(update.kind !== undefined ? { kind: update.kind } : {}),
        ...(update.status !== undefined ? { status: update.status } : {}),
        ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
        ...(update.rawOutput !== undefined ? { rawOutput: update.rawOutput } : {}),
        ...(update.content !== undefined ? { content: update.content } : {}),
      };
    case "usage_update":
      return { type: "usage", update, ...(metadata ? { metadata } : {}) };
    default:
      return metadata && typeof metadata.totalTokens === "number"
        ? { type: "usage", update, metadata }
        : null;
  }
}

export class OpenCodeAcpTransport {
  readonly #options: Required<
    Pick<OpenCodeAcpTransportOptions, "commandTimeoutMs" | "closeTimeoutMs">
  > &
    OpenCodeAcpTransportOptions;
  #activePrompt: ActivePrompt | null = null;
  #child: ChildProcessWithoutNullStreams | null = null;
  #closed = false;
  #closing = false;
  #connection: ClientSideConnection | null = null;
  #initialize: InitializeResponse | null = null;
  #sessionId: string | null = null;

  constructor(options: OpenCodeAcpTransportOptions) {
    this.#options = {
      commandTimeoutMs: 30_000,
      closeTimeoutMs: 2_000,
      ...options,
    };
  }

  get sessionId(): string {
    if (!this.#sessionId) throw new Error("OpenCode ACP Session is not open");
    return this.#sessionId;
  }

  async inspect(): Promise<InitializeResponse> {
    if (this.#sessionId) throw new Error("OpenCode ACP inspection cannot reuse an open Session");
    try {
      const initialize = await this.#ensureInitialized();
      const connection = this.#connection;
      if (!connection) throw new OpenCodeTransportError("unavailable", "OpenCode ACP is unavailable");
      if (initialize.agentCapabilities?.sessionCapabilities?.list) {
        await withTimeout(
          connection.listSessions({ cwd: this.#options.cwd }),
          this.#options.commandTimeoutMs,
          "OpenCode Session inspection",
        );
      }
      const session = await withTimeout(
        connection.newSession({ cwd: this.#options.cwd, mcpServers: [] }),
        this.#options.commandTimeoutMs,
        "OpenCode Session creation",
      );
      if (Array.isArray(session.configOptions)) {
        return {
          ...initialize,
          _meta: {
            ...(isRecord(initialize._meta) ? initialize._meta : {}),
            modelState: session.configOptions,
          },
        };
      }
      return initialize;
    } catch (error) {
      const classified = classifyStartupError(error);
      await this.close().catch(() => undefined);
      throw classified;
    }
  }

  getHistory(): OpenCodeStoredSession | null {
    const sessionId = this.sessionId;
    const dbPath = openCodeDatabasePath({
      environment: this.#options.environment,
    });
    return readOpenCodeHistory(dbPath, sessionId);
  }

  async open(
    input: { kind: "create" } | { kind: "resume"; sessionId: string },
  ): Promise<OpenCodeOpenResult> {
    if (this.#sessionId || this.#closed)
      throw new Error("OpenCode ACP Transport cannot be opened twice");
    try {
      const initialize = await this.#ensureInitialized();
      const connection = this.#connection;
      if (!connection) throw new OpenCodeTransportError("unavailable", "OpenCode ACP is unavailable");
      let session: NewSessionResponse | LoadSessionResponse;
      let sessionId: string;
      if (input.kind === "create") {
        const created = await withTimeout(
          connection.newSession({ cwd: this.#options.cwd, mcpServers: [] }),
          this.#options.commandTimeoutMs,
          "OpenCode Session creation",
        );
        session = created;
        sessionId = created.sessionId;
      } else {
        session = await withTimeout(
          connection.loadSession({
            cwd: this.#options.cwd,
            mcpServers: [],
            sessionId: input.sessionId,
          }),
          this.#options.commandTimeoutMs,
          "OpenCode Session load",
        );
        sessionId = input.sessionId;
      }
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        throw new OpenCodeTransportError("protocolError", "OpenCode ACP returned no Session identity");
      }
      this.#sessionId = sessionId;
      const history = this.getHistory();
      return {
        initialize,
        session,
        sessionId,
        history,
      };
    } catch (error) {
      const classified = classifyStartupError(error);
      await this.close().catch(() => undefined);
      throw classified;
    }
  }

  async #ensureInitialized(): Promise<InitializeResponse> {
    if (this.#initialize) return this.#initialize;
    if (this.#child || this.#closed) {
      throw new Error("OpenCode ACP Transport cannot be started twice");
    }
    const executable = resolveOpenCodeExecutable({
      ...(this.#options.command ? { command: this.#options.command } : {}),
      environment: this.#options.environment ?? process.env,
    });
    const invocation = openCodeInvocation(executable);
    const child = spawn(invocation.command, invocation.arguments, {
      cwd: this.#options.cwd,
      env: { ...process.env, ...this.#options.environment },
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    this.#child = child;
    child.stderr.resume();
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      }),
      this.#options.commandTimeoutMs,
      "OpenCode CLI startup",
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
        }) satisfies Client,
      stream,
    );
    this.#connection = connection;
    child.once("error", (error) =>
      this.#fault(new OpenCodeTransportError("processExited", error.message)),
    );
    child.once("exit", (code, signal) => {
      if (!this.#closing && !this.#closed) {
        this.#fault(
          new OpenCodeTransportError(
            "processExited",
            `OpenCode ACP exited (code=${code}, signal=${signal})`,
          ),
        );
      }
    });
    const initialize = await withTimeout(
      connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "codexhost", version: "1.0.0" },
      }),
      this.#options.commandTimeoutMs,
      "OpenCode ACP initialize",
    );
    if (initialize.protocolVersion !== PROTOCOL_VERSION) {
      throw new OpenCodeTransportError(
        "protocolError",
        `OpenCode ACP negotiated unsupported protocol version ${initialize.protocolVersion}`,
      );
    }
    this.#initialize = initialize;
    return initialize;
  }

  async runTurn(
    text: string,
    onEvent: ActivePrompt["onEvent"],
    onPermission: ActivePrompt["onPermission"],
  ): Promise<PromptResponse> {
    const connection = this.#connection;
    if (!connection || !this.#sessionId || this.#closed || this.#closing) {
      throw new OpenCodeTransportError("unavailable", "OpenCode ACP Session is unavailable");
    }
    if (this.#activePrompt) throw new Error("OpenCode ACP Session already has an active Prompt");
    const active = { onEvent, onPermission };
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

  async setModel(modelId: string, reasoningEffort?: string): Promise<void> {
    const connection = this.#connection;
    if (!connection || !this.#sessionId) throw new Error("OpenCode ACP Session is unavailable");
    try {
      await connection.request<unknown, Record<string, unknown>>("session/set_model", {
        sessionId: this.#sessionId,
        modelId,
        ...(reasoningEffort ? { reasoningEffort } : {}),
      });
    } catch (error) {
      const text = errorText(error).toLowerCase();
      if (text.includes("model not found")) {
        throw new OpenCodeTransportError("protocolError", "OpenCode rejected Model configuration");
      }
      throw error;
    }
  }

  cancel(): Promise<void> {
    const connection = this.#connection;
    if (!connection || !this.#sessionId || !this.#activePrompt) {
      return Promise.reject(new Error("OpenCode ACP Session has no cancellable Prompt"));
    }
    return connection.cancel({ sessionId: this.#sessionId });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closing = true;
    const child = this.#child;
    const connection = this.#connection;
    if (
      connection &&
      this.#sessionId &&
      this.#initialize?.agentCapabilities?.sessionCapabilities?.close
    ) {
      await connection.closeSession({ sessionId: this.#sessionId }).catch(() => undefined);
    }
    if (child?.stdin.writable) child.stdin.end();
    if (child && !(await waitForExit(child, this.#options.closeTimeoutMs))) {
      signalProcessTree(child, "SIGTERM");
      if (!(await waitForExit(child, this.#options.closeTimeoutMs))) {
        signalProcessTree(child, "SIGKILL");
        await waitForExit(child, this.#options.closeTimeoutMs);
      }
    }
    this.#closed = true;
    this.#closing = false;
    this.#activePrompt = null;
  }

  #handleUpdate(notification: SessionNotification): void {
    if (this.#sessionId && notification.sessionId !== this.#sessionId) return;
    const metadata = isRecord(notification._meta) ? notification._meta : undefined;
    const event = transportEvent(notification.update, metadata);
    if (!event) return;
    this.#activePrompt?.onEvent(event);
  }

  #handlePermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (params.sessionId !== this.#sessionId || !this.#activePrompt) {
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    }
    return this.#activePrompt.onPermission({ request: params, options: params.options });
  }

  #fault(error: OpenCodeTransportError): void {
    if (this.#closing || this.#closed) return;
    this.#options.onFault?.(error);
  }
}
