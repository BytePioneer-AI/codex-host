import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";

import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  ndJsonStream,
  type Client,
  type InitializeResponse,
  type LoadSessionResponse,
  type NewSessionResponse,
  type PermissionOption,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import { sanitizeDiagnosticTail } from "@codexhost/harness-adapter";

import {
  CursorExecutableError,
  cursorInvocation,
  resolveCursorExecutable,
  withNodeRuntimeOnPath,
} from "./command.js";

export type CursorTransportFaultKind =
  | "notInstalled"
  | "notExecutable"
  | "wrongIdentity"
  | "authenticationRequired"
  | "unavailable"
  | "protocolError"
  | "processExited";

export class CursorTransportError extends Error {
  readonly diagnostic: string | undefined;

  constructor(
    readonly kind: CursorTransportFaultKind,
    message: string,
    options?: ErrorOptions & { diagnostic?: string },
  ) {
    super(message, options);
    this.diagnostic = options?.diagnostic;
    this.name = "CursorTransportError";
  }
}

export type CursorTransportEvent =
  | { type: "user.text"; text: string; messageId?: string }
  | { type: "agent.text"; text: string; messageId?: string }
  | { type: "agent.thought"; text: string; messageId?: string }
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
    }
  | { type: "usage"; used?: number; size?: number };

export interface CursorPermissionRequest {
  request: RequestPermissionRequest;
  options: PermissionOption[];
}

export interface CursorAcpTransportOptions {
  cwd: string;
  command?: string;
  environment?: NodeJS.ProcessEnv;
  commandTimeoutMs?: number;
  closeTimeoutMs?: number;
  onFault?: (error: CursorTransportError) => void;
}

export type CursorOpenInput = { kind: "create" } | { kind: "resume"; sessionId: string };

export interface CursorOpenResult {
  initialize: InitializeResponse;
  session: NewSessionResponse | LoadSessionResponse;
  sessionId: string;
  loadSessionSupported: boolean;
  replay: CursorTransportEvent[];
}

export interface CursorAcpTransportLike {
  readonly sessionId: string;
  readonly stderrTail?: string;
  readonly loadSessionSupported: boolean;
  inspect(): Promise<InitializeResponse>;
  open(input: CursorOpenInput): Promise<CursorOpenResult>;
  getHistory(): Promise<CursorTransportEvent[]>;
  runTurn(
    text: string,
    onEvent: (event: CursorTransportEvent) => void,
    onPermission: (request: CursorPermissionRequest) => Promise<RequestPermissionResponse>,
  ): Promise<PromptResponse>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

interface ActivePrompt {
  onEvent(event: CursorTransportEvent): void;
  onPermission(request: CursorPermissionRequest): Promise<RequestPermissionResponse>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function cursorLoadSessionSupported(initialize: InitializeResponse): boolean {
  return initialize.agentCapabilities?.loadSession === true;
}

export function transportEvent(update: SessionUpdate): CursorTransportEvent | null {
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
    case "usage_update": {
      const used = "used" in update && typeof update.used === "number" ? update.used : undefined;
      const size = "size" in update && typeof update.size === "number" ? update.size : undefined;
      if (used === undefined && size === undefined) return null;
      return {
        type: "usage",
        ...(used !== undefined ? { used } : {}),
        ...(size !== undefined ? { size } : {}),
      };
    }
    default:
      return null;
  }
}

function classifyStartupError(error: unknown): CursorTransportError {
  if (error instanceof CursorTransportError) return error;
  if (error instanceof CursorExecutableError) {
    const kind =
      error.kind === "notExecutable" || error.kind === "wrongIdentity"
        ? error.kind
        : "notInstalled";
    return new CursorTransportError(kind, error.message, {
      cause: error,
      ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}),
    });
  }
  if (error instanceof RequestError && (error.code === -32000 || /auth/iu.test(error.message))) {
    return new CursorTransportError(
      "authenticationRequired",
      "Cursor CLI authentication is required. Run `cursor-agent login` first.",
      { cause: error },
    );
  }
  const text = errorText(error).toLowerCase();
  if (
    text.includes("auth_required") ||
    text.includes("authentication required") ||
    text.includes("not logged in") ||
    text.includes("cursor_login")
  ) {
    return new CursorTransportError(
      "authenticationRequired",
      "Cursor CLI authentication is required. Run `cursor-agent login` first.",
      { cause: error },
    );
  }
  return new CursorTransportError("unavailable", "Cursor CLI could not start", { cause: error });
}

function classifyTurnError(error: unknown): CursorTransportError {
  if (error instanceof CursorTransportError) return error;
  const text = errorText(error);
  if (/connection closed|exited|EPIPE|ECONNRESET/iu.test(text)) {
    return new CursorTransportError("processExited", `Cursor ACP exited: ${text}`, {
      cause: error instanceof Error ? error : undefined,
    });
  }
  return new CursorTransportError("unavailable", text, {
    cause: error instanceof Error ? error : undefined,
  });
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, operation: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new CursorTransportError("unavailable", `${operation} timed out`)),
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

export class CursorAcpTransport implements CursorAcpTransportLike {
  readonly #options: Required<
    Pick<CursorAcpTransportOptions, "commandTimeoutMs" | "closeTimeoutMs">
  > &
    CursorAcpTransportOptions;
  #activePrompt: ActivePrompt | null = null;
  #child: ChildProcessWithoutNullStreams | null = null;
  #closed = false;
  #closing = false;
  #connection: ClientSideConnection | null = null;
  #history: CursorTransportEvent[] = [];
  #initialize: InitializeResponse | null = null;
  #replay: CursorTransportEvent[] | null = null;
  #sessionId: string | null = null;
  #stderrTail = "";

  constructor(options: CursorAcpTransportOptions) {
    this.#options = {
      commandTimeoutMs: 30_000,
      closeTimeoutMs: 2_000,
      ...options,
    };
  }

  get sessionId(): string {
    if (!this.#sessionId) throw new Error("Cursor ACP Session is not open");
    return this.#sessionId;
  }

  get stderrTail(): string {
    return this.#stderrTail;
  }

  get loadSessionSupported(): boolean {
    return this.#initialize ? cursorLoadSessionSupported(this.#initialize) : false;
  }

  async inspect(): Promise<InitializeResponse> {
    if (this.#sessionId) throw new Error("Cursor ACP inspection cannot reuse an open Session");
    try {
      return await this.#ensureInitialized();
    } catch (error) {
      const classified = classifyStartupError(error);
      await this.close().catch(() => undefined);
      throw classified;
    }
  }

  async getHistory(): Promise<CursorTransportEvent[]> {
    return [...this.#history];
  }

  async open(input: CursorOpenInput): Promise<CursorOpenResult> {
    if (this.#sessionId || this.#closed) {
      throw new Error("Cursor ACP Transport cannot be opened twice");
    }
    try {
      const initialize = await this.#ensureInitialized();
      const connection = this.#connection;
      if (!connection) throw new CursorTransportError("unavailable", "Cursor ACP is unavailable");
      await this.#authenticateIfNeeded(initialize, connection);
      const loadSessionSupported = cursorLoadSessionSupported(initialize);
      this.#replay = input.kind === "resume" ? [] : null;
      let session: NewSessionResponse | LoadSessionResponse;
      let sessionId: string;
      if (input.kind === "create") {
        const created = await withTimeout(
          connection.newSession({ cwd: this.#options.cwd, mcpServers: [] }),
          this.#options.commandTimeoutMs,
          "Cursor Session creation",
        );
        session = created;
        sessionId = created.sessionId;
      } else {
        if (!loadSessionSupported) {
          throw new CursorTransportError(
            "protocolError",
            "Cursor ACP does not advertise session/load",
          );
        }
        session = await withTimeout(
          connection.loadSession({
            cwd: this.#options.cwd,
            mcpServers: [],
            sessionId: input.sessionId,
          }),
          this.#options.commandTimeoutMs,
          "Cursor Session load",
        );
        sessionId = input.sessionId;
      }
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        throw new CursorTransportError("protocolError", "Cursor ACP returned no Session identity");
      }
      this.#sessionId = sessionId;
      const replay = this.#replay ?? [];
      this.#replay = null;
      this.#history = [...replay];
      return { initialize, session, sessionId, loadSessionSupported, replay };
    } catch (error) {
      const classified = classifyStartupError(error);
      await this.close().catch(() => undefined);
      throw classified;
    }
  }

  async runTurn(
    text: string,
    onEvent: ActivePrompt["onEvent"],
    onPermission: ActivePrompt["onPermission"],
  ): Promise<PromptResponse> {
    const connection = this.#connection;
    if (!connection || !this.#sessionId || this.#closed || this.#closing) {
      throw new CursorTransportError("unavailable", "Cursor ACP Session is unavailable");
    }
    if (this.#activePrompt) throw new Error("Cursor ACP Session already has an active Prompt");
    const active = { onEvent, onPermission };
    this.#activePrompt = active;
    try {
      return await connection.prompt({
        sessionId: this.#sessionId,
        prompt: [{ type: "text", text }],
      });
    } catch (error) {
      throw classifyTurnError(error);
    } finally {
      if (this.#activePrompt === active) this.#activePrompt = null;
    }
  }

  cancel(): Promise<void> {
    const connection = this.#connection;
    if (!connection || !this.#sessionId || !this.#activePrompt) {
      return Promise.reject(new Error("Cursor ACP Session has no cancellable operation"));
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

  async #ensureInitialized(): Promise<InitializeResponse> {
    if (this.#initialize) return this.#initialize;
    if (this.#child || this.#closed)
      throw new Error("Cursor ACP Transport cannot be started twice");
    const resolution = resolveCursorExecutable({
      ...(this.#options.command ? { command: this.#options.command } : {}),
      environment: this.#options.environment ?? process.env,
    });
    const environment = withNodeRuntimeOnPath({
      ...process.env,
      ...this.#options.environment,
    });
    const invocation = cursorInvocation(resolution.executable, process.platform, environment);
    const child = spawn(invocation.command, invocation.arguments, {
      cwd: this.#options.cwd,
      env: environment,
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
      this.#options.commandTimeoutMs,
      "Cursor CLI startup",
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
      this.#fault(new CursorTransportError("processExited", error.message)),
    );
    child.once("exit", (code, signal) => {
      if (!this.#closing && !this.#closed) {
        this.#fault(
          new CursorTransportError(
            "processExited",
            `Cursor ACP exited (code=${code}, signal=${signal})`,
          ),
        );
      }
    });
    const initialize = await withTimeout(
      connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "codexhost", version: "0.3.5" },
      }),
      this.#options.commandTimeoutMs,
      "Cursor ACP initialize",
    );
    if (typeof initialize.protocolVersion !== "number") {
      throw new CursorTransportError("protocolError", "Cursor ACP returned no protocol version");
    }
    this.#initialize = initialize;
    return initialize;
  }

  async #authenticateIfNeeded(
    initialize: InitializeResponse,
    connection: ClientSideConnection,
  ): Promise<void> {
    const methods = initialize.authMethods ?? [];
    if (methods.length === 0) return;
    const methodId = methods.find((method) => method.id === "cursor_login")?.id ?? methods[0]?.id;
    if (!methodId) return;
    try {
      await withTimeout(
        connection.authenticate({ methodId }),
        this.#options.commandTimeoutMs,
        "Cursor ACP authenticate",
      );
    } catch (error) {
      throw classifyStartupError(error);
    }
  }

  #handleUpdate(notification: SessionNotification): void {
    if (this.#sessionId && notification.sessionId !== this.#sessionId) return;
    const event = transportEvent(notification.update);
    if (!event) return;
    this.#history.push(event);
    if (this.#replay) this.#replay.push(event);
    else this.#activePrompt?.onEvent(event);
  }

  #handlePermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (params.sessionId !== this.#sessionId || !this.#activePrompt) {
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    }
    return this.#activePrompt.onPermission({ request: params, options: params.options });
  }

  #fault(error: CursorTransportError): void {
    if (this.#closing || this.#closed) return;
    this.#options.onFault?.(error);
  }
}
