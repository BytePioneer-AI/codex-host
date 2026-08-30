import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";

import { sanitizeDiagnosticTail } from "@codexhost/harness-adapter";
import type { HarnessPermissionModeId } from "@codexhost/shared-contracts";
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

import { QwenCodeExecutableError, qwenInvocation, resolveQwenExecutable } from "./command.js";

export type QwenCodeTransportFaultKind =
  "notInstalled" | "authenticationRequired" | "unavailable" | "protocolError" | "processExited";

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
  | { type: "user.text"; text: string; metadata?: Record<string, unknown> }
  | { type: "agent.text"; text: string; metadata?: Record<string, unknown> }
  | { type: "agent.thought"; text: string; metadata?: Record<string, unknown> }
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
  | { type: "usage"; update?: SessionUpdate; metadata?: Record<string, unknown> }
  | { type: "mode.changed"; modeId: string };

export interface QwenCodePermissionRequest {
  request: RequestPermissionRequest;
  options: PermissionOption[];
}

export interface QwenCodeAcpTransportOptions {
  cwd: string;
  command?: string;
  environment?: NodeJS.ProcessEnv;
  commandTimeoutMs?: number;
  closeTimeoutMs?: number;
  onFault?: (error: QwenCodeTransportError) => void;
}

export interface QwenCodeOpenInput {
  kind: "create" | "resume";
  sessionId?: string;
}

export interface QwenCodeOpenResult {
  initialize: InitializeResponse;
  session: NewSessionResponse | LoadSessionResponse;
  sessionId: string;
  replay: QwenCodeTransportEvent[];
  resumed: boolean;
  /** Present when the native Session reported its active ACP Permission Mode. */
  sessionModeId?: string;
  models: unknown;
}

interface ActivePrompt {
  onEvent(event: QwenCodeTransportEvent): void;
  onPermission(request: QwenCodePermissionRequest): Promise<RequestPermissionResponse>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function classifyStartupError(error: unknown): QwenCodeTransportError {
  if (error instanceof QwenCodeTransportError) return error;
  if (error instanceof QwenCodeExecutableError) {
    return new QwenCodeTransportError("notInstalled", error.message, { cause: error });
  }
  const text = errorText(error).toLowerCase();
  if (
    text.includes("auth_required") ||
    text.includes("authentication") ||
    text.includes("not logged in") ||
    text.includes("sign in")
  ) {
    return new QwenCodeTransportError(
      "authenticationRequired",
      "Qwen Code CLI authentication is required",
      { cause: error },
    );
  }
  return new QwenCodeTransportError("unavailable", "Qwen Code CLI could not start", {
    cause: error,
  });
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, operation: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new QwenCodeTransportError("unavailable", `${operation} timed out`)),
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

export function transportEvent(
  update: SessionUpdate,
  metadata?: Record<string, unknown>,
): QwenCodeTransportEvent | null {
  if (update.sessionUpdate === "current_mode_update") {
    const currentModeId = (update as unknown as Record<string, unknown>).currentModeId;
    if (typeof currentModeId === "string") {
      return { type: "mode.changed", modeId: currentModeId };
    }
    return null;
  }
  if ((update as unknown as Record<string, unknown>).sessionUpdate === "usage_update") {
    return { type: "usage", update, ...(metadata ? { metadata } : {}) };
  }
  if (metadata && isRecord(metadata.usage)) {
    return { type: "usage", metadata };
  }
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
        ...(metadata ? { metadata } : {}),
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
    default:
      return null;
  }
}

export class QwenCodeAcpTransport {
  readonly #options: Required<
    Pick<QwenCodeAcpTransportOptions, "commandTimeoutMs" | "closeTimeoutMs">
  > &
    QwenCodeAcpTransportOptions;
  #activePrompt: ActivePrompt | null = null;
  #child: ChildProcessWithoutNullStreams | null = null;
  #closed = false;
  #closing = false;
  #connection: ClientSideConnection | null = null;
  #initialize: InitializeResponse | null = null;
  #replay: QwenCodeTransportEvent[] | null = null;
  #sessionId: string | null = null;
  #stderrTail = "";

  constructor(options: QwenCodeAcpTransportOptions) {
    this.#options = {
      commandTimeoutMs: 30_000,
      closeTimeoutMs: 2_000,
      ...options,
    };
  }

  get sessionId(): string {
    if (!this.#sessionId) throw new Error("Qwen Code ACP Session is not open");
    return this.#sessionId;
  }

  get stderrTail(): string {
    return this.#stderrTail;
  }

  async inspect(): Promise<{ initialize: InitializeResponse; models: unknown }> {
    if (this.#sessionId) throw new Error("Qwen Code ACP inspection cannot reuse an open Session");
    try {
      const initialize = await this.#ensureInitialized();
      const connection = this.#connection;
      if (!connection) {
        throw new QwenCodeTransportError("unavailable", "Qwen Code ACP is unavailable");
      }
      if (initialize.agentCapabilities?.sessionCapabilities?.list) {
        await withTimeout(
          connection.listSessions({ cwd: this.#options.cwd }),
          this.#options.commandTimeoutMs,
          "Qwen Code Session inspection",
        );
      }
      // Qwen Code only reports its Model catalog on session/open responses, so
      // inspection opens a throwaway Session (no prompt, no Model requests).
      const session = await withTimeout(
        connection.newSession({ cwd: this.#options.cwd, mcpServers: [] }),
        this.#options.commandTimeoutMs,
        "Qwen Code Session inspection",
      );
      const models = (session as unknown as Record<string, unknown>).models;
      return { initialize, models };
    } catch (error) {
      const classified = classifyStartupError(error);
      await this.close().catch(() => undefined);
      throw classified;
    }
  }

  async open(input: QwenCodeOpenInput): Promise<QwenCodeOpenResult> {
    if (this.#sessionId || this.#closed) {
      throw new Error("Qwen Code ACP Transport cannot be opened twice");
    }
    try {
      const initialize = await this.#ensureInitialized();
      const connection = this.#connection;
      if (!connection) {
        throw new QwenCodeTransportError("unavailable", "Qwen Code ACP is unavailable");
      }
      this.#replay = input.kind === "resume" ? [] : null;
      let session: NewSessionResponse | LoadSessionResponse;
      let sessionId: string;
      if (input.kind === "create") {
        const created = await withTimeout(
          connection.newSession({ cwd: this.#options.cwd, mcpServers: [] }),
          this.#options.commandTimeoutMs,
          "Qwen Code Session creation",
        );
        session = created;
        sessionId = created.sessionId;
      } else {
        if (!input.sessionId) {
          throw new QwenCodeTransportError(
            "protocolError",
            "Qwen Code resume requires a Session identity",
          );
        }
        session = await withTimeout(
          connection.loadSession({
            cwd: this.#options.cwd,
            mcpServers: [],
            sessionId: input.sessionId,
          }),
          this.#options.commandTimeoutMs,
          "Qwen Code Session load",
        );
        sessionId = input.sessionId;
      }
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        throw new QwenCodeTransportError(
          "protocolError",
          "Qwen Code ACP returned no Session identity",
        );
      }
      this.#sessionId = sessionId;
      const replay = this.#replay ?? [];
      this.#replay = null;
      const modes = (session as unknown as Record<string, unknown>).modes;
      const sessionModeId =
        isRecord(modes) && typeof modes.currentModeId === "string"
          ? modes.currentModeId
          : undefined;
      return {
        initialize,
        session,
        sessionId,
        replay,
        resumed: input.kind === "resume",
        models: (session as unknown as Record<string, unknown>).models,
        ...(sessionModeId ? { sessionModeId } : {}),
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
      throw new Error("Qwen Code ACP Transport cannot be started twice");
    }
    const executable = resolveQwenExecutable({
      ...(this.#options.command ? { command: this.#options.command } : {}),
      environment: this.#options.environment ?? process.env,
    });
    const invocation = qwenInvocation(executable);
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
      this.#options.commandTimeoutMs,
      "Qwen Code CLI startup",
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
      this.#fault(new QwenCodeTransportError("processExited", error.message)),
    );
    child.once("exit", (code, signal) => {
      if (!this.#closing && !this.#closed) {
        this.#fault(
          new QwenCodeTransportError(
            "processExited",
            `Qwen Code ACP exited (code=${code}, signal=${signal})`,
          ),
        );
      }
    });
    const initialize = await withTimeout(
      connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "codexhost", version: "0.1.6" },
      }),
      this.#options.commandTimeoutMs,
      "Qwen Code ACP initialize",
    );
    if (initialize.protocolVersion !== PROTOCOL_VERSION) {
      throw new QwenCodeTransportError(
        "protocolError",
        `Qwen Code ACP negotiated unsupported protocol version ${initialize.protocolVersion}`,
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
      throw new QwenCodeTransportError("unavailable", "Qwen Code ACP Session is unavailable");
    }
    if (this.#activePrompt) throw new Error("Qwen Code ACP Session already has an active Prompt");
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

  async setModel(nativeModelId: string): Promise<void> {
    const connection = this.#connection;
    if (!connection || !this.#sessionId) throw new Error("Qwen Code ACP Session is unavailable");
    await withTimeout(
      connection.request("session/set_model", {
        sessionId: this.#sessionId,
        modelId: nativeModelId,
      }),
      this.#options.commandTimeoutMs,
      "Qwen Code Model configuration",
    );
  }

  async setPermissionMode(permissionModeId: HarnessPermissionModeId): Promise<void> {
    const connection = this.#connection;
    if (!connection || !this.#sessionId || this.#closed || this.#closing) {
      throw new QwenCodeTransportError("unavailable", "Qwen Code ACP Session is unavailable");
    }
    if (this.#activePrompt) {
      throw new QwenCodeTransportError(
        "unavailable",
        "Qwen Code ACP Session already has an active operation",
      );
    }
    await withTimeout(
      connection.request("session/set_mode", {
        sessionId: this.#sessionId,
        modeId: permissionModeId,
      }),
      this.#options.commandTimeoutMs,
      "Qwen Code Permission Mode configuration",
    );
  }

  cancel(): Promise<void> {
    const connection = this.#connection;
    if (!connection || !this.#sessionId || !this.#activePrompt) {
      return Promise.reject(new Error("Qwen Code ACP Session has no cancellable operation"));
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
    if (this.#replay) this.#replay.push(event);
    else this.#activePrompt?.onEvent(event);
  }

  #handlePermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (params.sessionId !== this.#sessionId || !this.#activePrompt) {
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    }
    return this.#activePrompt.onPermission({ request: params, options: params.options });
  }

  #fault(error: QwenCodeTransportError): void {
    if (this.#closing || this.#closed) return;
    this.#options.onFault?.(error);
  }
}
