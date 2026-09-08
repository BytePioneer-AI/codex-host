import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";

import { sanitizeDiagnosticTail } from "@codexhost/harness-adapter";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type InitializeResponse,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";

import { HermesExecutableError, hermesInvocation, resolveHermesExecutable } from "./command.js";

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

/**
 * The ACP wire format carries an UNSTABLE `models` block on session
 * new/load/fork responses (Hermes Python SDK sends it); the TS SDK does not
 * type it yet, so read it loosely and keep a minimal local shape.
 */
export interface HermesModelInfo {
  modelId: string;
  name: string;
  description?: string;
}

export interface HermesModelState {
  availableModels: HermesModelInfo[];
  currentModelId?: string;
}

export interface HermesModeState {
  currentModeId: string;
  availableModes: Array<{ id: string; name: string; description?: string }>;
}

export interface HermesOpenSession {
  sessionId: string;
  models: HermesModelState | null;
  modes: HermesModeState | null;
}

export type HermesTransportEvent =
  | { type: "user.text"; text: string }
  | { type: "agent.text"; text: string }
  | { type: "agent.thought"; text: string }
  | { type: "tool.call"; toolCallId: string; update: SessionUpdate }
  | { type: "tool.update"; toolCallId: string; update: SessionUpdate }
  | { type: "usage"; used?: number; size?: number };

export interface HermesPermissionRequest {
  request: RequestPermissionRequest;
  options: RequestPermissionRequest["options"];
}

export interface HermesAcpTransportOptions {
  cwd: string;
  command?: string;
  environment?: NodeJS.ProcessEnv;
  commandTimeoutMs?: number;
  closeTimeoutMs?: number;
  onFault?: (error: HermesTransportError) => void;
}

export type HermesOpenInput =
  | { kind: "create" }
  | { kind: "resume"; sessionId: string }
  | { kind: "fork"; sourceSessionId: string };

export interface HermesOpenResult {
  initialize: InitializeResponse;
  session: HermesOpenSession;
  sessionId: string;
  /** session/load replays the transcript before responding (ACP spec). */
  replay: HermesTransportEvent[];
}

interface ActivePrompt {
  onEvent(event: HermesTransportEvent): void;
  onPermission(request: HermesPermissionRequest): Promise<RequestPermissionResponse>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function looseModels(value: unknown): HermesModelState | null {
  if (!isRecord(value) || !Array.isArray(value.availableModels)) return null;
  const availableModels: HermesModelInfo[] = [];
  for (const entry of value.availableModels) {
    if (!isRecord(entry) || typeof entry.modelId !== "string") continue;
    availableModels.push({
      modelId: entry.modelId,
      ...(typeof entry.name === "string" ? { name: entry.name } : { name: entry.modelId }),
      ...(typeof entry.description === "string" ? { description: entry.description } : {}),
    });
  }
  if (availableModels.length === 0) return null;
  return {
    availableModels,
    ...(typeof value.currentModelId === "string" ? { currentModelId: value.currentModelId } : {}),
  };
}

function looseModes(value: unknown): HermesModeState | null {
  if (!isRecord(value) || typeof value.currentModeId !== "string") return null;
  const availableModes: HermesModeState["availableModes"] = [];
  if (Array.isArray(value.availableModes)) {
    for (const entry of value.availableModes) {
      if (!isRecord(entry) || typeof entry.id !== "string") continue;
      availableModes.push({
        id: entry.id,
        name: typeof entry.name === "string" ? entry.name : entry.id,
        ...(typeof entry.description === "string" ? { description: entry.description } : {}),
      });
    }
  }
  return { currentModeId: value.currentModeId, availableModes };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorDetails(error: unknown): string {
  if (isRecord(error)) {
    const data = error.data;
    if (isRecord(data) && typeof data.details === "string" && data.details.trim().length > 0) {
      return data.details.trim();
    }
  }
  return errorText(error);
}

function classifyStartupError(error: unknown): HermesTransportError {
  if (error instanceof HermesTransportError) return error;
  if (error instanceof HermesExecutableError) {
    return new HermesTransportError("notInstalled", error.message, { cause: error });
  }
  const detail = errorDetails(error);
  const text = detail.toLowerCase();
  if (
    text.includes("auth_required") ||
    text.includes("authentication") ||
    text.includes("not configured") ||
    text.includes("no provider") ||
    text.includes("no llm provider")
  ) {
    return new HermesTransportError("authenticationRequired", detail, {
      cause: error,
      diagnostic: detail,
    });
  }
  return new HermesTransportError("unavailable", detail, {
    cause: error,
    diagnostic: detail,
  });
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

export function transportEvent(update: SessionUpdate): HermesTransportEvent | null {
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
      };
    case "tool_call":
      return { type: "tool.call", toolCallId: update.toolCallId, update };
    case "tool_call_update":
      return { type: "tool.update", toolCallId: update.toolCallId, update };
    case "usage_update":
      return { type: "usage", used: update.used, size: update.size };
    default:
      return null;
  }
}

export class HermesAcpTransport {
  readonly #options: Required<
    Pick<HermesAcpTransportOptions, "commandTimeoutMs" | "closeTimeoutMs">
  > &
    HermesAcpTransportOptions;
  #activePrompt: ActivePrompt | null = null;
  #child: ChildProcessWithoutNullStreams | null = null;
  #closed = false;
  #closing = false;
  #connection: ClientSideConnection | null = null;
  #initialize: InitializeResponse | null = null;
  #replay: HermesTransportEvent[] | null = null;
  #sessionId: string | null = null;
  #stderrTail = "";

  /** Late binding: the Session registers its fault consumer on construction. */
  onFault: (error: HermesTransportError) => void = () => undefined;

  constructor(options: HermesAcpTransportOptions) {
    this.#options = {
      commandTimeoutMs: 30_000,
      closeTimeoutMs: 2_000,
      ...options,
    };
    if (options.onFault) this.onFault = options.onFault;
  }

  get sessionId(): string {
    if (!this.#sessionId) throw new Error("Hermes ACP Session is not open");
    return this.#sessionId;
  }

  get stderrTail(): string {
    return this.#stderrTail;
  }

  async inspect(): Promise<InitializeResponse> {
    if (this.#sessionId) throw new Error("Hermes ACP inspection cannot reuse an open Session");
    try {
      // Hermes persists every created Session immediately, so inspection
      // stops at initialize + capability advertisement and never creates,
      // loads, or lists user Sessions.
      return await this.#ensureInitialized();
    } catch (error) {
      const classified = classifyStartupError(error);
      await this.close().catch(() => undefined);
      throw classified;
    }
  }

  /**
   * Start the CLI and return the live connection for one-shot queries
   * (session/list import discovery). The caller owns transport.close().
   */
  async probeConnection(): Promise<ClientSideConnection> {
    await this.#ensureInitialized();
    if (!this.#connection)
      throw new HermesTransportError("unavailable", "Hermes ACP is unavailable");
    return this.#connection;
  }

  async open(input: HermesOpenInput): Promise<HermesOpenResult> {
    if (this.#sessionId || this.#closed)
      throw new Error("Hermes ACP Transport cannot be opened twice");
    try {
      const initialize = await this.#ensureInitialized();
      const connection = this.#connection;
      if (!connection) throw new HermesTransportError("unavailable", "Hermes ACP is unavailable");
      this.#replay = input.kind === "create" ? null : [];
      let session: HermesOpenSession;
      if (input.kind === "create") {
        const created = await withTimeout(
          connection.newSession({ cwd: this.#options.cwd, mcpServers: [] }),
          this.#options.commandTimeoutMs,
          "Hermes Session creation",
        );
        session = {
          sessionId: created.sessionId,
          models: looseModels((created as unknown as Record<string, unknown>).models),
          modes: looseModes(created.modes),
        };
      } else if (input.kind === "fork") {
        const forked = (await withTimeout(
          connection.request("session/fork", {
            cwd: this.#options.cwd,
            sessionId: input.sourceSessionId,
            mcpServers: [],
          }),
          this.#options.commandTimeoutMs,
          "Hermes Session fork",
        )) as unknown;
        if (
          !isRecord(forked) ||
          typeof forked.sessionId !== "string" ||
          forked.sessionId.length === 0
        ) {
          throw new HermesTransportError(
            "protocolError",
            "Hermes fork returned no Session identity",
          );
        }
        if (forked.sessionId === input.sourceSessionId) {
          throw new HermesTransportError(
            "protocolError",
            "Hermes fork returned the source Session identity",
          );
        }
        session = {
          sessionId: forked.sessionId,
          models: looseModels(forked.models),
          modes: looseModes(forked.modes),
        };
      } else {
        const loaded = await withTimeout(
          connection.loadSession({
            cwd: this.#options.cwd,
            mcpServers: [],
            sessionId: input.sessionId,
          }),
          this.#options.commandTimeoutMs,
          "Hermes Session load",
        );
        if (!loaded) {
          throw new HermesTransportError(
            "unavailable",
            `Hermes Session ${input.sessionId} could not be loaded`,
          );
        }
        session = {
          sessionId: input.sessionId,
          models: looseModels((loaded as unknown as Record<string, unknown>).models),
          modes: looseModes(loaded.modes),
        };
      }
      this.#sessionId = session.sessionId;
      const replay = this.#replay ?? [];
      this.#replay = null;
      return { initialize, session, sessionId: session.sessionId, replay };
    } catch (error) {
      const classified = classifyStartupError(error);
      await this.close().catch(() => undefined);
      throw classified;
    }
  }

  async setModel(modelId: string): Promise<void> {
    const connection = this.#connection;
    if (!connection || !this.#sessionId) throw new Error("Hermes ACP Session is unavailable");
    try {
      const response = (await withTimeout(
        connection.request("session/set_model", { sessionId: this.#sessionId, modelId }),
        this.#options.commandTimeoutMs,
        "Hermes Model selection",
      )) as unknown;
      // Hermes answers null when the Session is gone; the SDK throws -32602
      // for unknown models, which surfaces as a rejection here.
      if (response === null || response === undefined) {
        throw new HermesTransportError("unavailable", "Hermes rejected Model selection");
      }
    } catch (error) {
      throw classifyStartupError(error);
    }
  }

  async setPermissionMode(modeId: string): Promise<void> {
    const connection = this.#connection;
    if (!connection || !this.#sessionId) throw new Error("Hermes ACP Session is unavailable");
    try {
      const response = (await withTimeout(
        connection.request("session/set_mode", { sessionId: this.#sessionId, modeId }),
        this.#options.commandTimeoutMs,
        "Hermes Permission Mode selection",
      )) as unknown;
      if (response === null || response === undefined) {
        throw new HermesTransportError("unavailable", "Hermes rejected Permission Mode selection");
      }
    } catch (error) {
      throw classifyStartupError(error);
    }
  }

  async runTurn(
    text: string,
    onEvent: ActivePrompt["onEvent"],
    onPermission: ActivePrompt["onPermission"],
  ): Promise<PromptResponse> {
    const connection = this.#connection;
    if (!connection || !this.#sessionId || this.#closed || this.#closing) {
      throw new HermesTransportError("unavailable", "Hermes ACP Session is unavailable");
    }
    if (this.#activePrompt) throw new Error("Hermes ACP Session already has an active Prompt");
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

  async cancel(): Promise<void> {
    const connection = this.#connection;
    if (!connection || !this.#sessionId || !this.#activePrompt) {
      throw new HermesTransportError("unavailable", "Hermes ACP Session has no cancellable Turn");
    }
    try {
      await connection.cancel({ sessionId: this.#sessionId });
    } catch (error) {
      throw classifyStartupError(error);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closing = true;
    const child = this.#child;
    // The ACP adapter exposes no session/close; ending stdin exits the process.
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

  #handleUpdate(notification: { sessionId: string; update: SessionUpdate }): void {
    if (this.#sessionId && notification.sessionId !== this.#sessionId) return;
    const event = transportEvent(notification.update);
    if (!event) return;
    if (this.#replay) this.#replay.push(event);
    else if (this.#activePrompt) this.#activePrompt.onEvent(event);
  }

  #handlePermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (params.sessionId !== this.#sessionId || !this.#activePrompt) {
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    }
    return this.#activePrompt.onPermission({ request: params, options: params.options });
  }

  #fault(error: HermesTransportError): void {
    if (this.#closing || this.#closed) return;
    this.onFault(error);
  }

  async #ensureInitialized(): Promise<InitializeResponse> {
    if (this.#initialize) return this.#initialize;
    if (this.#child || this.#closed)
      throw new Error("Hermes ACP Transport cannot be started twice");
    const executable = resolveHermesExecutable({
      ...(this.#options.command ? { command: this.#options.command } : {}),
      environment: this.#options.environment ?? process.env,
    });
    const invocation = hermesInvocation(executable);
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
      "Hermes CLI startup",
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
      this.#fault(new HermesTransportError("processExited", error.message)),
    );
    child.once("exit", (code, signal) => {
      if (!this.#closing && !this.#closed) {
        this.#fault(
          new HermesTransportError(
            "processExited",
            `Hermes ACP exited (code=${code}, signal=${signal})`,
          ),
        );
      }
    });
    const initialize = await withTimeout(
      connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "codexhost", version: "0.1.0" },
      }),
      this.#options.commandTimeoutMs,
      "Hermes ACP initialize",
    );
    if (initialize.protocolVersion !== PROTOCOL_VERSION) {
      throw new HermesTransportError(
        "protocolError",
        `Hermes ACP negotiated unsupported protocol version ${initialize.protocolVersion}`,
      );
    }
    this.#initialize = initialize;
    return initialize;
  }
}
