import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";

import { sanitizeDiagnosticTail } from "@codexhost/harness-adapter";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  RequestError,
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

import { GrokExecutableError, grokInvocation, resolveGrokExecutable } from "./command.js";
import {
  GROK_SESSION_DELETE_METHOD,
  GROK_SESSION_FORK_METHOD,
  isGrokMethodNotFound,
  parseGrokForkResponse,
  type GrokForkParams,
} from "./grok-fork.js";
import {
  grokCompactionEventFromUpdate,
  isGrokExtensionSessionUpdateMethod,
} from "./grok-compaction.js";
import {
  GROK_COMPACT_CONVERSATION_FALLBACK_METHOD,
  GROK_COMPACT_CONVERSATION_METHOD,
  parseGrokCompactResult,
  type GrokCompactResult,
} from "./grok-manual-compaction.js";
import {
  GROK_REWIND_EXECUTE_METHOD,
  parseGrokRewindResponse,
  type GrokRewindParams,
} from "./grok-rewind.js";

export type GrokTransportFaultKind =
  "notInstalled" | "authenticationRequired" | "unavailable" | "protocolError" | "processExited";

export class GrokTransportError extends Error {
  readonly diagnostic: string | undefined;

  constructor(
    readonly kind: GrokTransportFaultKind,
    message: string,
    options?: ErrorOptions & { diagnostic?: string },
  ) {
    super(message, options);
    this.diagnostic = options?.diagnostic;
    this.name = "GrokTransportError";
  }
}

export type GrokTransportEvent =
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
  | { type: "usage"; update: SessionUpdate; metadata?: Record<string, unknown> }
  | {
      type: "turn.completed";
      nativeTurnKey: string;
      stopReason: string;
      usage?: unknown;
      metadata?: Record<string, unknown>;
    }
  | { type: "rewind.marker"; targetPromptIndex: number; metadata?: Record<string, unknown> }
  | {
      type: "compaction.started";
      tokensUsed?: number;
      contextWindowTokens?: number;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "compaction.completed";
      outcome: "succeeded" | "cancelled" | "failed";
      tokensBefore?: number;
      tokensAfter?: number;
      contextWindowTokens?: number;
      errorMessage?: string;
      metadata?: Record<string, unknown>;
    };

export interface GrokPermissionRequest {
  request: RequestPermissionRequest;
  options: PermissionOption[];
}

export interface GrokAcpTransportOptions {
  cwd: string;
  command?: string;
  environment?: NodeJS.ProcessEnv;
  commandTimeoutMs?: number;
  closeTimeoutMs?: number;
  onFault?: (error: GrokTransportError) => void;
}

export interface GrokForkOpenInput {
  kind: "fork";
  sourceSessionId: string;
  sourceCwd: string;
  targetPromptIndex: number;
  sessionKind?: string;
  sourceWorkspaceDir?: string;
}

export interface GrokRewindOpenInput {
  kind: "rewind";
  sessionId: string;
  targetPromptIndex: number;
}

export interface GrokNativeSessionLocation {
  cwd: string;
  sourceWorkspaceDir?: string;
}

export type GrokOpenInput =
  | { kind: "create" }
  | { kind: "resume"; sessionId: string }
  | GrokForkOpenInput
  | GrokRewindOpenInput;

export interface GrokOpenResult {
  initialize: InitializeResponse;
  session: NewSessionResponse | LoadSessionResponse;
  sessionId: string;
  replay: GrokTransportEvent[];
  signals?: unknown;
}
interface ActivePrompt {
  onEvent(event: GrokTransportEvent): void;
  onPermission(request: GrokPermissionRequest): Promise<RequestPermissionResponse>;
}

interface ActiveCompact {
  onEvent(event: GrokTransportEvent): void;
  cancellationRequested: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function classifyStartupError(error: unknown): GrokTransportError {
  if (error instanceof GrokTransportError) return error;
  if (error instanceof GrokExecutableError) {
    return new GrokTransportError("notInstalled", error.message, { cause: error });
  }
  const text = errorText(error).toLowerCase();
  if (
    text.includes("auth_required") ||
    text.includes("authentication") ||
    text.includes("not logged in") ||
    text.includes("sign in")
  ) {
    return new GrokTransportError("authenticationRequired", "Grok CLI authentication is required", {
      cause: error,
    });
  }
  return new GrokTransportError("unavailable", "Grok CLI could not start", { cause: error });
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, operation: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new GrokTransportError("unavailable", `${operation} timed out`)),
        milliseconds,
      );
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
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
): GrokTransportEvent | null {
  const extension = update as unknown as Record<string, unknown>;
  if (
    extension.sessionUpdate === "turn_completed" &&
    typeof extension.prompt_id === "string" &&
    extension.prompt_id.length > 0 &&
    typeof extension.stop_reason === "string"
  ) {
    return {
      type: "turn.completed",
      nativeTurnKey: extension.prompt_id,
      stopReason: extension.stop_reason,
      ...(extension.usage !== undefined ? { usage: extension.usage } : {}),
      ...(metadata ? { metadata } : {}),
    };
  }
  if (extension.sessionUpdate === "rewind_marker") {
    const targetPromptIndex =
      typeof extension.targetPromptIndex === "number"
        ? extension.targetPromptIndex
        : typeof extension.target_prompt_index === "number"
          ? extension.target_prompt_index
          : null;
    if (
      targetPromptIndex === null ||
      !Number.isInteger(targetPromptIndex) ||
      targetPromptIndex < 0
    ) {
      return null;
    }
    return { type: "rewind.marker", targetPromptIndex, ...(metadata ? { metadata } : {}) };
  }
  const compaction = grokCompactionEventFromUpdate(extension);
  if (compaction) return compaction;
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

function grokHomeDir(options: Pick<GrokAcpTransportOptions, "environment">): string {
  const environment = { ...process.env, ...options.environment };
  const home = environment.HOME ?? environment.USERPROFILE ?? os.homedir();
  return environment.GROK_HOME ?? path.join(home, ".grok");
}

function nativeSessionFile(
  options: GrokAcpTransportOptions,
  sessionId: string,
  fileName: string,
): string {
  return path.join(
    grokHomeDir(options),
    "sessions",
    encodeURIComponent(path.resolve(options.cwd)),
    sessionId,
    fileName,
  );
}

function nativeHistoryPath(options: GrokAcpTransportOptions, sessionId: string): string {
  return nativeSessionFile(options, sessionId, "updates.jsonl");
}

async function readNativeSignals(
  options: GrokAcpTransportOptions,
  sessionId: string,
): Promise<unknown | undefined> {
  try {
    return JSON.parse(
      await readFile(nativeSessionFile(options, sessionId, "signals.json"), "utf8"),
    );
  } catch {
    return undefined;
  }
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

export async function locateGrokNativeSession(
  options: Pick<GrokAcpTransportOptions, "environment">,
  sessionId: string,
): Promise<GrokNativeSessionLocation | null> {
  if (sessionId.length === 0) return null;
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await readdir(path.join(grokHomeDir(options), "sessions"), { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw new GrokTransportError("unavailable", "Grok Native Session directory could not be read", {
      cause: error,
    });
  }
  const matches: GrokNativeSessionLocation[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let summaryRaw: string;
    try {
      summaryRaw = await readFile(
        path.join(grokHomeDir(options), "sessions", entry.name, sessionId, "summary.json"),
        "utf8",
      );
    } catch (error) {
      if (isMissingFile(error) || (isRecord(error) && error.code === "ENOTDIR")) continue;
      throw new GrokTransportError(
        "unavailable",
        "Grok Native Session metadata could not be read",
        {
          cause: error,
        },
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(summaryRaw);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const info = parsed.info;
    const cwd =
      isRecord(info) && typeof info.cwd === "string" && info.cwd.length > 0
        ? path.resolve(info.cwd)
        : path.resolve(decodeURIComponent(entry.name));
    const sourceWorkspaceDir =
      typeof parsed.source_workspace_dir === "string" && parsed.source_workspace_dir.length > 0
        ? path.resolve(parsed.source_workspace_dir)
        : undefined;
    matches.push({
      cwd,
      ...(sourceWorkspaceDir ? { sourceWorkspaceDir } : {}),
    });
  }
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

export async function readGrokNativeHistory(
  options: GrokAcpTransportOptions,
  sessionId: string,
): Promise<GrokTransportEvent[]> {
  try {
    return parseNativeHistory(
      await readFile(
        nativeHistoryPath({ ...options, cwd: path.resolve(options.cwd) }, sessionId),
        "utf8",
      ),
      sessionId,
    );
  } catch (error) {
    if (isMissingFile(error)) return [];
    if (error instanceof GrokTransportError) throw error;
    throw new GrokTransportError("unavailable", "Grok Native history could not be read", {
      cause: error,
    });
  }
}

function parseNativeHistory(contents: string, sessionId: string): GrokTransportEvent[] {
  const events: GrokTransportEvent[] = [];
  for (const line of contents.split("\n")) {
    if (line.length === 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      throw new GrokTransportError("protocolError", "Grok Native history contains invalid JSON");
    }
    if (!isRecord(record) || !isRecord(record.params)) continue;
    const params = record.params;
    if (params.sessionId !== sessionId || !isRecord(params.update)) continue;
    const metadata = isRecord(params._meta) ? params._meta : undefined;
    const event = transportEvent(params.update as SessionUpdate, metadata);
    if (event) events.push(metadata ? { ...event, metadata } : event);
  }
  return events;
}

export class GrokAcpTransport {
  readonly #options: Required<
    Pick<GrokAcpTransportOptions, "commandTimeoutMs" | "closeTimeoutMs">
  > &
    GrokAcpTransportOptions;
  #activeCompact: ActiveCompact | null = null;
  #activePrompt: ActivePrompt | null = null;
  #child: ChildProcessWithoutNullStreams | null = null;
  #closed = false;
  #closing = false;
  #connection: ClientSideConnection | null = null;
  #initialize: InitializeResponse | null = null;
  #replay: GrokTransportEvent[] | null = null;
  #sessionId: string | null = null;
  #stderrTail = "";

  constructor(options: GrokAcpTransportOptions) {
    this.#options = {
      commandTimeoutMs: 30_000,
      closeTimeoutMs: 2_000,
      ...options,
    };
  }

  get sessionId(): string {
    if (!this.#sessionId) throw new Error("Grok ACP Session is not open");
    return this.#sessionId;
  }

  get stderrTail(): string {
    return this.#stderrTail;
  }

  async inspect(): Promise<InitializeResponse> {
    if (this.#sessionId) throw new Error("Grok ACP inspection cannot reuse an open Session");
    try {
      const initialize = await this.#ensureInitialized();
      if (initialize.agentCapabilities?.sessionCapabilities?.list) {
        const connection = this.#connection;
        if (!connection) throw new GrokTransportError("unavailable", "Grok ACP is unavailable");
        await withTimeout(
          connection.listSessions({ cwd: this.#options.cwd }),
          this.#options.commandTimeoutMs,
          "Grok Session inspection",
        );
      }
      return initialize;
    } catch (error) {
      const classified = classifyStartupError(error);
      await this.close().catch(() => undefined);
      throw classified;
    }
  }

  async getHistory(): Promise<GrokTransportEvent[]> {
    return this.readHistory(this.sessionId);
  }

  async readHistory(sessionId: string, cwd = this.#options.cwd): Promise<GrokTransportEvent[]> {
    return readGrokNativeHistory({ ...this.#options, cwd }, sessionId);
  }

  async locateSession(sessionId: string): Promise<GrokNativeSessionLocation | null> {
    return locateGrokNativeSession(this.#options, sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.#ensureInitialized();
    if (!this.#connection) throw new GrokTransportError("unavailable", "Grok ACP is unavailable");
    await withTimeout(
      this.#connection.request(GROK_SESSION_DELETE_METHOD, {
        sessionId,
        cwd: this.#options.cwd,
      }),
      this.#options.commandTimeoutMs,
      "Grok Session delete",
    );
  }

  async open(input: GrokOpenInput): Promise<GrokOpenResult> {
    if (this.#sessionId || this.#closed)
      throw new Error("Grok ACP Transport cannot be opened twice");
    try {
      const initialize = await this.#ensureInitialized();
      const connection = this.#connection;
      if (!connection) throw new GrokTransportError("unavailable", "Grok ACP is unavailable");
      this.#replay =
        input.kind === "resume" || input.kind === "fork" || input.kind === "rewind" ? [] : null;
      let session: NewSessionResponse | LoadSessionResponse;
      let sessionId: string;
      if (input.kind === "create") {
        const created = await withTimeout(
          connection.newSession({ cwd: this.#options.cwd, mcpServers: [] }),
          this.#options.commandTimeoutMs,
          "Grok Session creation",
        );
        session = created;
        sessionId = created.sessionId;
      } else if (input.kind === "fork") {
        const forked = await this.#forkSession({
          sourceSessionId: input.sourceSessionId,
          sourceCwd: input.sourceCwd,
          newCwd: this.#options.cwd,
          targetPromptIndex: input.targetPromptIndex,
          ...(input.sessionKind ? { sessionKind: input.sessionKind } : {}),
          ...(input.sourceWorkspaceDir ? { sourceWorkspaceDir: input.sourceWorkspaceDir } : {}),
        });
        try {
          session = await withTimeout(
            connection.loadSession({
              cwd: this.#options.cwd,
              mcpServers: [],
              sessionId: forked.newSessionId,
            }),
            this.#options.commandTimeoutMs,
            "Grok Session load",
          );
        } catch (error) {
          throw new GrokTransportError(
            "unavailable",
            `Grok Fork succeeded as ${forked.newSessionId} but session/load failed`,
            { cause: error },
          );
        }
        sessionId = forked.newSessionId;
      } else {
        session = await withTimeout(
          connection.loadSession({
            cwd: this.#options.cwd,
            mcpServers: [],
            sessionId: input.sessionId,
          }),
          this.#options.commandTimeoutMs,
          "Grok Session load",
        );
        sessionId = input.sessionId;
        if (input.kind === "rewind") {
          await this.#rewindSession({
            sessionId,
            targetPromptIndex: input.targetPromptIndex,
            force: true,
            mode: "conversation_only",
          });
        }
      }
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        throw new GrokTransportError("protocolError", "Grok ACP returned no Session identity");
      }
      this.#sessionId = sessionId;
      const replay = this.#replay ?? [];
      this.#replay = null;
      const signals =
        input.kind === "resume" || input.kind === "fork" || input.kind === "rewind"
          ? await readNativeSignals(this.#options, sessionId)
          : undefined;
      return {
        initialize,
        session,
        sessionId,
        replay,
        ...(signals !== undefined ? { signals } : {}),
      };
    } catch (error) {
      const classified = classifyStartupError(error);
      await this.close().catch(() => undefined);
      throw classified;
    }
  }

  async #rewindSession(params: GrokRewindParams): Promise<void> {
    if (!this.#connection) throw new GrokTransportError("unavailable", "Grok ACP is unavailable");
    try {
      const raw = await withTimeout(
        this.#connection.request(GROK_REWIND_EXECUTE_METHOD, params),
        this.#options.commandTimeoutMs,
        "Grok Session rewind",
      );
      const parsed = parseGrokRewindResponse(raw);
      if (!parsed) {
        throw new GrokTransportError("protocolError", "Grok Rewind returned an invalid result");
      }
      if (!parsed.success) {
        throw new GrokTransportError(
          "unavailable",
          parsed.error && parsed.error.length > 0
            ? `Grok Native Rewind failed: ${parsed.error}`
            : "Grok Native Rewind did not truncate history",
        );
      }
    } catch (error) {
      if (error instanceof GrokTransportError) throw error;
      if (error instanceof RequestError && error.code === -32601) {
        throw new GrokTransportError(
          "protocolError",
          `Grok ACP Method Not Found: ${GROK_REWIND_EXECUTE_METHOD}`,
          { cause: error },
        );
      }
      throw new GrokTransportError("unavailable", "Grok Native Rewind failed", { cause: error });
    }
  }

  async #forkSession(params: GrokForkParams): Promise<{ newSessionId: string }> {
    if (!this.#connection) throw new GrokTransportError("unavailable", "Grok ACP is unavailable");
    try {
      const raw = await withTimeout(
        this.#connection.request(GROK_SESSION_FORK_METHOD, params),
        this.#options.commandTimeoutMs,
        "Grok Session fork",
      );
      const parsed = parseGrokForkResponse(raw);
      if (!parsed) {
        throw new GrokTransportError("protocolError", "Grok Fork returned no Session identity");
      }
      if (parsed.newSessionId === params.sourceSessionId) {
        throw new GrokTransportError(
          "protocolError",
          "Grok Fork returned the source Session identity",
        );
      }
      return parsed;
    } catch (error) {
      if (error instanceof GrokTransportError) throw error;
      if (error instanceof RequestError && error.code === -32601) {
        throw new GrokTransportError(
          "protocolError",
          `Grok ACP Method Not Found: ${GROK_SESSION_FORK_METHOD}`,
          { cause: error },
        );
      }
      throw new GrokTransportError("unavailable", "Grok Native Fork failed", { cause: error });
    }
  }

  async #ensureInitialized(): Promise<InitializeResponse> {
    if (this.#initialize) return this.#initialize;
    if (this.#child || this.#closed) throw new Error("Grok ACP Transport cannot be started twice");
    const executable = resolveGrokExecutable({
      ...(this.#options.command ? { command: this.#options.command } : {}),
      environment: this.#options.environment ?? process.env,
    });
    const invocation = grokInvocation(executable);
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
      "Grok CLI startup",
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
          extNotification: (method, params) => this.#handleExtensionNotification(method, params),
        }) satisfies Client,
      stream,
    );
    this.#connection = connection;
    child.once("error", (error) =>
      this.#fault(new GrokTransportError("processExited", error.message)),
    );
    child.once("exit", (code, signal) => {
      if (!this.#closing && !this.#closed) {
        this.#fault(
          new GrokTransportError(
            "processExited",
            `Grok ACP exited (code=${code}, signal=${signal})`,
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
      "Grok ACP initialize",
    );
    if (initialize.protocolVersion !== PROTOCOL_VERSION) {
      throw new GrokTransportError(
        "protocolError",
        `Grok ACP negotiated unsupported protocol version ${initialize.protocolVersion}`,
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
      throw new GrokTransportError("unavailable", "Grok ACP Session is unavailable");
    }
    if (this.#activePrompt) throw new Error("Grok ACP Session already has an active Prompt");
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

  async compact(
    userContext: string | undefined,
    onEvent: (event: GrokTransportEvent) => void,
  ): Promise<GrokCompactResult> {
    const connection = this.#connection;
    if (!connection || !this.#sessionId || this.#closed || this.#closing) {
      throw new GrokTransportError("unavailable", "Grok ACP Session is unavailable");
    }
    if (this.#activePrompt || this.#activeCompact) {
      throw new GrokTransportError(
        "unavailable",
        "Grok ACP Session already has an active operation",
      );
    }
    const active: ActiveCompact = { onEvent, cancellationRequested: false };
    this.#activeCompact = active;
    try {
      const params = {
        sessionId: this.#sessionId,
        ...(userContext !== undefined ? { userContext } : {}),
      };
      let raw: unknown;
      try {
        raw = await connection.request<unknown, unknown>(GROK_COMPACT_CONVERSATION_METHOD, params);
      } catch (error) {
        if (!isGrokMethodNotFound(error)) throw error;
        raw = await connection.request<unknown, unknown>(
          GROK_COMPACT_CONVERSATION_FALLBACK_METHOD,
          params,
        );
      }
      await yieldToEventLoop();
      return parseGrokCompactResult(raw, active.cancellationRequested);
    } catch (error) {
      if (error instanceof GrokTransportError) throw error;
      throw new GrokTransportError("unavailable", "Grok Native Compact failed", { cause: error });
    } finally {
      if (this.#activeCompact === active) this.#activeCompact = null;
    }
  }
  async setModel(modelId: string, reasoningEffort?: string): Promise<void> {
    const connection = this.#connection;
    if (!connection || !this.#sessionId) throw new Error("Grok ACP Session is unavailable");
    const response = await connection.request<unknown, Record<string, unknown>>(
      "session/set_model",
      {
        sessionId: this.#sessionId,
        modelId,
        ...(reasoningEffort ? { reasoningEffort } : {}),
      },
    );
    if (!isRecord(response) || !isRecord(response._meta) || !isRecord(response._meta.model)) {
      throw new GrokTransportError("protocolError", "Grok rejected Model configuration");
    }
    const selected = response._meta.model.Ok;
    if (selected !== modelId) {
      throw new GrokTransportError("protocolError", "Grok activated a different Model");
    }
  }

  cancel(): Promise<void> {
    const connection = this.#connection;
    if (!connection || !this.#sessionId || (!this.#activePrompt && !this.#activeCompact)) {
      return Promise.reject(new Error("Grok ACP Session has no cancellable operation"));
    }
    if (this.#activeCompact) this.#activeCompact.cancellationRequested = true;
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
    this.#activeCompact = null;
  }

  #handleUpdate(notification: SessionNotification): void {
    if (this.#sessionId && notification.sessionId !== this.#sessionId) return;
    const metadata = isRecord(notification._meta) ? notification._meta : undefined;
    const event = transportEvent(notification.update, metadata);
    if (!event) return;
    const enriched = metadata ? { ...event, metadata } : event;
    if (this.#replay) this.#replay.push(enriched);
    else if (this.#activePrompt) this.#activePrompt.onEvent(enriched);
    else this.#activeCompact?.onEvent(enriched);
  }

  #handleExtensionNotification(method: string, params: Record<string, unknown>): void {
    if (!isGrokExtensionSessionUpdateMethod(method)) return;
    if (typeof params.sessionId !== "string" || !isRecord(params.update)) return;
    this.#handleUpdate(params as SessionNotification);
  }

  #handlePermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (params.sessionId !== this.#sessionId || !this.#activePrompt) {
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    }
    return this.#activePrompt.onPermission({ request: params, options: params.options });
  }

  #fault(error: GrokTransportError): void {
    if (this.#closing || this.#closed) return;
    this.#options.onFault?.(error);
  }
}
