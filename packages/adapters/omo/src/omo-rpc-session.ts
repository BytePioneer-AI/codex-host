import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { sanitizeDiagnosticTail } from "@codexhost/harness-adapter";
import { commandInvocation, type CommandInvocation } from "@codexhost/harness-discovery";

import { resolveOmoExecutable, withNodeRuntimeOnPath } from "./command.js";
import {
  isOmoResponseFrame,
  OmoJsonlFramer,
  OmoProtocolError,
  type OmoEventFrame,
  type OmoFrame,
  type OmoResponseFrame,
} from "./omo-protocol.js";
import { isWindowsUncDirectory, omoUncNodeInvocation } from "./omo-unc-launch.js";

/**
 * Process and transport layer for OmO's classic stdio RPC (`omo --mode rpc`).
 *
 * This module owns one child process, command/response correlation, and the
 * event stream. It carries no Thread, Turn, or interaction semantics; those
 * belong to the Harness Session built on top of it.
 *
 * Intended use:
 *
 * ```ts
 * const rpc = new OmoRpcSession({ cwd, environment, onFault });
 * await rpc.start();            // spawns, declares the client role, reads state
 * const events = rpc.events();  // one subscriber, consumed until done
 * const state = rpc.state;      // parsed get_state result
 * const data = (await rpc.send("get_state", {})).data;
 * await rpc.close();            // idempotent, bounded, kills the process tree
 * ```
 *
 * Failure channels:
 *
 * - `start()` and `send()` reject with an `OmoRpcFaultError` once the transport
 *   is unusable (`notInstalled`, `unavailable`, `protocolError`, `processExited`).
 *   The same instance is passed to `onFault` and returned by {@link fault}.
 * - An individual command may fail without faulting the session:
 *   `OmoRpcCommandTimeoutError` when the answer misses its budget (the session
 *   keeps working and a late answer is ignored), and `OmoRpcResponseError` when
 *   the engine refuses it natively (`errorCode` and its category are preserved).
 * - `OmoRpcClosedError` after {@link close}. A deliberate close never reports a
 *   fault, even if the child exits while closing.
 *
 * The event iterator ends (yields `done`) on close and on fault; faults are
 * reported once through `onFault`, not through the iterator.
 *
 * Startup chatter is filtered before the event sink: `extension_ui_request`
 * frames for `setStatus`/`setWidget`, `settings_source_selected`,
 * `model_changed`, and `entry_appended` records whose entry is marked
 * `startupBookkeeping`. Everything else, including unknown event types, reaches
 * the subscriber in wire order. Effective model and permission state come from
 * `get_state`, not from these events.
 *
 * The child environment is the caller's base environment plus
 * `PI_SKIP_VERSION_CHECK=1` and `PI_TELEMETRY=0` (verified for the installed
 * 5.1.83 runtime in `docs/environment-variables.md`), with the Node.js runtime
 * directory appended to `PATH` so npm shims resolve `node`.
 */

/** A native Model reference as `get_state` reports it. */
export interface OmoNativeModelRef {
  readonly provider: string;
  readonly id: string;
}

/** Typed view of a `get_state` answer. Unknown native fields stay in `raw`. */
export interface OmoRpcSessionState {
  readonly sessionId: string | null;
  readonly sessionFile: string | null;
  readonly model: OmoNativeModelRef | null;
  readonly thinkingLevel: string | null;
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  readonly currentTurnId: string | null;
  readonly permissionPreset: string | null;
  readonly effectivePermissionPreset: string | null;
  readonly pendingDialogs: readonly Readonly<Record<string, unknown>>[];
  readonly messageCount: number | null;
  readonly raw: Readonly<Record<string, unknown>>;
}

export type OmoRpcFaultKind = "notInstalled" | "unavailable" | "protocolError" | "processExited";

/**
 * The transport is unusable; every pending command is rejected with the same
 * instance and the event iterator has ended. `diagnostic` is the sanitized
 * stderr tail at the time of the fault.
 */
export class OmoRpcFaultError extends Error {
  constructor(
    readonly kind: OmoRpcFaultKind,
    message: string,
    readonly diagnostic?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "OmoRpcFaultError";
  }
}

/** One command missed its budget and was abandoned; the session remains usable. */
export class OmoRpcCommandTimeoutError extends Error {
  constructor(
    readonly command: string,
    readonly timeoutMs: number,
  ) {
    super(`OmO RPC '${command}' command timed out after ${timeoutMs}ms`);
    this.name = "OmoRpcCommandTimeoutError";
  }
}

/**
 * Transport-level reading of a native `errorCode`, for the Session's mapping
 * into harness error codes. `other` covers refusals with no shared meaning.
 */
export type OmoRpcErrorCategory = "busy" | "authentication" | "configuration" | "other";

const BUSY_ERROR_CODES: ReadonlySet<string> = new Set([
  "streaming",
  "session_busy",
  "turn_active",
  "session_busy_lifecycle",
]);
const AUTHENTICATION_ERROR_CODES: ReadonlySet<string> = new Set([
  "provider_credentials_missing",
  "provider_credentials_expired",
]);
const CONFIGURATION_ERROR_CODES: ReadonlySet<string> = new Set(["no_model_selected"]);

export function classifyOmoResponseError(errorCode: string | undefined): OmoRpcErrorCategory {
  if (errorCode === undefined) return "other";
  if (BUSY_ERROR_CODES.has(errorCode)) return "busy";
  if (AUTHENTICATION_ERROR_CODES.has(errorCode)) return "authentication";
  if (CONFIGURATION_ERROR_CODES.has(errorCode)) return "configuration";
  return "other";
}

/** The engine answered `success: false`. The native text is preserved verbatim. */
export class OmoRpcResponseError extends Error {
  readonly command: string;
  readonly errorCode: string | undefined;
  readonly category: OmoRpcErrorCategory;

  constructor(command: string, response: OmoResponseFrame) {
    super(response.error ?? `OmO RPC '${command}' command failed`);
    this.name = "OmoRpcResponseError";
    this.command = command;
    this.errorCode = response.errorCode;
    this.category = classifyOmoResponseError(response.errorCode);
  }
}

/** Admission is closed: the session was closed or faulted before the call. */
export class OmoRpcClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OmoRpcClosedError";
  }
}

/** An extension vetoed the requested Fork; no Session was switched. */
export class OmoRpcForkCancelledError extends Error {
  constructor(message = "OmO cancelled the requested Fork") {
    super(message);
    this.name = "OmoRpcForkCancelledError";
  }
}

/** A closed session's process tree outlived both bounded shutdown stages. */
export class OmoRpcCloseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OmoRpcCloseError";
  }
}

export interface OmoRpcSessionOptions {
  cwd: string;
  command?: string;
  environment?: NodeJS.ProcessEnv;
  /** Resume one session file. Without it the engine creates a new Session. */
  sessionFile?: string;
  /** Copy one session file into a new Session at startup (`--fork`). */
  forkSessionFile?: string;
  /** Per-command response budget; default 30s. */
  commandTimeoutMs?: number;
  /** Spawn and first-state budget; default 60s because a cold engine is slow. */
  startupTimeoutMs?: number;
  /** Each bounded shutdown stage; default 2s. */
  closeTimeoutMs?: number;
  /** Called once when the transport becomes unusable. Never called by close(). */
  onFault?: (fault: OmoRpcFaultError) => void;
}

export interface OmoRpcProcessOptions {
  readonly cwd: string;
  readonly command?: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly sessionFile?: string;
  readonly forkSessionFile?: string;
}

/** Injectable process boundary; the default adapter spawns the real CLI. */
export interface OmoRpcProcessAdapter {
  spawn(options: OmoRpcProcessOptions): ChildProcessWithoutNullStreams;
}

export interface OmoRpcProcessCommandDependencies {
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  isExecutable?(filePath: string): boolean;
  readText?(file: string): string | undefined;
  isFile?(file: string): boolean;
}

/**
 * Builds the launch invocation. A native `omo.exe` is started directly (no
 * shell, no path rewriting). A Windows `.cmd` shim is wrapped in `cmd.exe`
 * unless the working directory is UNC, where a recognised npm `omo-ai` shim is
 * converted to a direct Node invocation and any other batch launcher is
 * refused with `unavailable`.
 */
export function omoRpcProcessCommand(
  options: OmoRpcProcessOptions,
  dependencies: Partial<OmoRpcProcessCommandDependencies> = {},
): CommandInvocation {
  if (options.sessionFile && options.forkSessionFile) {
    throw new OmoRpcFaultError(
      "protocolError",
      "OmO RPC cannot combine Session resume and Fork startup",
    );
  }
  const platform = dependencies.platform ?? process.platform;
  const command = resolveOmoExecutable(
    {
      ...(options.command ? { command: options.command } : {}),
      environment: options.environment,
    },
    {
      platform,
      ...(dependencies.homeDirectory ? { homeDirectory: dependencies.homeDirectory } : {}),
      ...(dependencies.isExecutable ? { isExecutable: dependencies.isExecutable } : {}),
    },
  );
  if (!command) {
    throw new OmoRpcFaultError(
      "notInstalled",
      "The omo CLI was not found. Install omo from the official guide, or set CODEXHOST_OMO_COMMAND to its executable.",
    );
  }
  const arguments_ = [
    "--mode",
    "rpc",
    ...(options.forkSessionFile
      ? ["--fork", options.forkSessionFile]
      : options.sessionFile
        ? ["--session", options.sessionFile]
        : []),
  ];
  const extension = path.win32.extname(command).toLowerCase();
  if (platform !== "win32" || ![".cmd", ".bat"].includes(extension)) {
    return { command, arguments: arguments_, windowsVerbatimArguments: false };
  }
  if (isWindowsUncDirectory(options.cwd)) {
    try {
      return omoUncNodeInvocation(command, arguments_, options.environment, {
        ...(dependencies.readText ? { readText: dependencies.readText } : {}),
        ...(dependencies.isFile ? { isFile: dependencies.isFile } : {}),
      });
    } catch (error) {
      throw new OmoRpcFaultError("unavailable", message(error), undefined, errorOptions(error));
    }
  }
  return commandInvocation(command, arguments_, options.environment, platform);
}

const nodeProcessAdapter: OmoRpcProcessAdapter = {
  spawn(options) {
    const invocation = omoRpcProcessCommand(options);
    return spawn(invocation.command, invocation.arguments, {
      cwd: options.cwd,
      env: options.environment,
      // A POSIX process group is what makes the tree kill reach grandchildren.
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
  },
};

interface PendingCommand {
  readonly command: string;
  readonly resolve: (response: OmoResponseFrame) => void;
  readonly reject: (error: Error) => void;
  timeout: NodeJS.Timeout | null;
}

// Late answers to commands whose budget expired. Bounded so an engine that
// answers nothing cannot grow the set without limit; past the bound the oldest
// id is forgotten and its answer faults the session as unknown.
const MAX_EXPIRED_IDS = 64;

/**
 * Raw stderr retained for diagnostics. Sanitizing happens only when the tail is
 * published, so a secret split across chunks still matches its pattern; the
 * raw buffer is bounded here and `sanitizeDiagnosticTail` bounds the published
 * text again.
 */
const STDERR_TAIL_MAX_LENGTH = 8_192;

/** Width sent for compatibility; classic stdio renders no extension components. */
const OMO_CLIENT_WIDTH = 80;

/** The only client role this adapter claims. */
const OMO_CLIENT_CAPABILITIES: readonly string[] = Object.freeze(["interactive_user"]);

const STARTUP_UI_METHODS: ReadonlySet<string> = new Set(["setStatus", "setWidget"]);
const STARTUP_EVENT_TYPES: ReadonlySet<string> = new Set([
  "settings_source_selected",
  "model_changed",
]);

/** Transport noise emitted before (and around) startup; never Session content. */
function isStartupChatter(frame: OmoEventFrame): boolean {
  if (STARTUP_EVENT_TYPES.has(frame.type)) return true;
  if (frame.type === "extension_ui_request") {
    return typeof frame.method === "string" && STARTUP_UI_METHODS.has(frame.method);
  }
  if (frame.type === "entry_appended") {
    const entry = frame.entry;
    return isRecord(entry) && entry.startupBookkeeping === true;
  }
  return false;
}

/**
 * Parses a `get_state` payload. Known fields are type-checked; anything else is
 * preserved in `raw`. A malformed known field is a protocol fault, never a
 * defaulted value, because callers publish this as the Session's identity.
 */
export function parseOmoSessionState(data: unknown): OmoRpcSessionState {
  if (!isRecord(data)) {
    throw new OmoRpcFaultError("protocolError", "OmO RPC state response has no object data");
  }
  return {
    sessionId: optionalString(data.sessionId, "sessionId"),
    sessionFile: optionalString(data.sessionFile, "sessionFile"),
    model: optionalModel(data.model),
    thinkingLevel: optionalString(data.thinkingLevel, "thinkingLevel"),
    isStreaming: optionalBoolean(data.isStreaming, "isStreaming") ?? false,
    isCompacting: optionalBoolean(data.isCompacting, "isCompacting") ?? false,
    currentTurnId: optionalString(data.currentTurnId, "currentTurnId"),
    permissionPreset: optionalString(data.permissionPreset, "permissionPreset"),
    effectivePermissionPreset: optionalString(
      data.effectivePermissionPreset,
      "effectivePermissionPreset",
    ),
    pendingDialogs: optionalDialogs(data.pendingDialogs),
    messageCount: optionalCount(data.messageCount),
    raw: data,
  };
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new OmoRpcFaultError("protocolError", `OmO RPC state field '${field}' must be a string`);
  }
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new OmoRpcFaultError("protocolError", `OmO RPC state field '${field}' must be a boolean`);
  }
  return value;
}

function optionalCount(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new OmoRpcFaultError("protocolError", "OmO RPC state field 'messageCount' is invalid");
  }
  return value;
}

function optionalModel(value: unknown): OmoNativeModelRef | null {
  if (value === undefined || value === null) return null;
  if (
    !isRecord(value) ||
    typeof value.provider !== "string" ||
    value.provider.length === 0 ||
    typeof value.id !== "string" ||
    value.id.length === 0
  ) {
    throw new OmoRpcFaultError("protocolError", "OmO RPC state has an invalid Model reference");
  }
  return { provider: value.provider, id: value.id };
}

function optionalDialogs(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new OmoRpcFaultError("protocolError", "OmO RPC state pendingDialogs is invalid");
  }
  return value.map((dialog) => ({ ...dialog }));
}

/**
 * Single-subscriber ordered event queue. `end()` resolves a waiting reader with
 * `done`, so `for await` terminates on close and on fault alike.
 */
class OmoEventSink implements AsyncIterableIterator<OmoEventFrame> {
  #values: OmoEventFrame[] = [];
  #waiter: ((result: IteratorResult<OmoEventFrame>) => void) | null = null;
  #ended = false;
  #detached = false;

  push(frame: OmoEventFrame): void {
    if (this.#ended || this.#detached) return;
    const waiter = this.#waiter;
    if (waiter) {
      this.#waiter = null;
      waiter({ value: frame, done: false });
      return;
    }
    this.#values.push(frame);
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#values = [];
    const waiter = this.#waiter;
    this.#waiter = null;
    waiter?.({ value: undefined, done: true });
  }

  next(): Promise<IteratorResult<OmoEventFrame>> {
    const value = this.#values.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.#ended || this.#detached) return Promise.resolve({ value: undefined, done: true });
    if (this.#waiter) {
      return Promise.reject(new Error("OmO RPC event sink does not allow concurrent next() calls"));
    }
    return new Promise((resolve) => {
      this.#waiter = resolve;
    });
  }

  return(): Promise<IteratorResult<OmoEventFrame>> {
    this.#detached = true;
    this.#values = [];
    const waiter = this.#waiter;
    this.#waiter = null;
    waiter?.({ value: undefined, done: true });
    return Promise.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<OmoEventFrame> {
    return this;
  }
}

export class OmoRpcSession {
  readonly #options: Required<
    Pick<OmoRpcSessionOptions, "commandTimeoutMs" | "startupTimeoutMs" | "closeTimeoutMs">
  > &
    OmoRpcSessionOptions;
  readonly #processAdapter: OmoRpcProcessAdapter;
  readonly #framer = new OmoJsonlFramer();
  readonly #events = new OmoEventSink();
  readonly #pending = new Map<string, PendingCommand>();
  readonly #expired = new Set<string>();
  #child: ChildProcessWithoutNullStreams | null = null;
  #state: OmoRpcSessionState | null = null;
  #stderrRaw = "";
  #failed = false;
  #closed = false;
  #fault: OmoRpcFaultError | null = null;
  #closePromise: Promise<void> | null = null;
  #eventsSubscribed = false;

  constructor(
    options: OmoRpcSessionOptions,
    processAdapter: OmoRpcProcessAdapter = nodeProcessAdapter,
  ) {
    this.#options = {
      commandTimeoutMs: 30_000,
      startupTimeoutMs: 60_000,
      closeTimeoutMs: 2_000,
      ...options,
    };
    this.#processAdapter = processAdapter;
  }

  get state(): OmoRpcSessionState {
    if (!this.#state) throw new Error("OmO RPC Session has not started");
    return this.#state;
  }

  /** The diagnostic tail, sanitized from the raw bytes each time it is read. */
  get stderrTail(): string {
    return sanitizeDiagnosticTail(this.#stderrRaw);
  }

  /** The terminal fault, or null while the transport is usable. */
  get fault(): OmoRpcFaultError | null {
    return this.#fault;
  }

  /** The single subscriber. Events buffer until it is taken. */
  events(): AsyncIterableIterator<OmoEventFrame> {
    if (this.#eventsSubscribed) {
      throw new Error("OmO RPC Session allows one event subscriber");
    }
    this.#eventsSubscribed = true;
    return this.#events;
  }

  async start(): Promise<this> {
    if (this.#child || this.#closed) throw new Error("OmO RPC Session cannot be started twice");
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.#processAdapter.spawn({
        cwd: this.#options.cwd,
        ...(this.#options.command ? { command: this.#options.command } : {}),
        ...(this.#options.sessionFile ? { sessionFile: this.#options.sessionFile } : {}),
        ...(this.#options.forkSessionFile
          ? { forkSessionFile: this.#options.forkSessionFile }
          : {}),
        environment: withNodeRuntimeOnPath({
          ...process.env,
          ...this.#options.environment,
          PI_SKIP_VERSION_CHECK: "1",
          PI_TELEMETRY: "0",
        }),
      });
    } catch (error) {
      const fault = spawnFault(error);
      // The caller observes this launch failure directly; do not report it twice
      // through onFault, but leave the Session terminal rather than half-open.
      this.#failed = true;
      this.#closed = true;
      this.#fault = fault;
      this.#events.end();
      throw fault;
    }
    this.#child = child;
    this.#wire(child);
    try {
      await waitForSpawn(child, this.#options.startupTimeoutMs);
      await this.send(
        "set_client_info",
        { width: OMO_CLIENT_WIDTH, capabilities: [...OMO_CLIENT_CAPABILITIES] },
        { timeoutMs: this.#options.startupTimeoutMs },
      );
      await this.refreshState({ timeoutMs: this.#options.startupTimeoutMs });
      // The last startup answer and a bad frame can share one stdout chunk:
      // the response is delivered first, then the bad frame faults and closes
      // the transport. The startup sequence must not hand back a handle to an
      // instance that already failed.
      if (this.#fault) throw this.#fault;
    } catch (error) {
      const fault = this.#fault ?? this.#startupFault(error);
      this.#fail(fault);
      throw fault;
    }
    return this;
  }

  /** Sends `get_state` and replaces {@link state} with its parsed answer. */
  async refreshState(options: { timeoutMs?: number } = {}): Promise<OmoRpcSessionState> {
    const response = await this.send("get_state", {}, options);
    // A success that shares its chunk with a bad frame resolves first and
    // faults right after; a caller refreshing the native state must observe
    // the fault instead of the answer (direct `send` keeps its FIX-3 order).
    if (this.#fault) throw this.#fault;
    let state: OmoRpcSessionState;
    try {
      state = parseOmoSessionState(response.data);
    } catch (error) {
      const fault =
        error instanceof OmoRpcFaultError
          ? error
          : new OmoRpcFaultError("protocolError", message(error), this.stderrTail);
      this.#fail(fault);
      throw fault;
    }
    this.#state = state;
    return state;
  }

  /**
   * Writes one command and resolves with its correlated response. A timeout
   * abandons only this command; a late answer is ignored. Native refusals reject
   * with `OmoRpcResponseError`, keeping `errorCode`.
   */
  send(
    command: string,
    payload: Readonly<Record<string, unknown>> = {},
    options: { timeoutMs?: number } = {},
  ): Promise<OmoResponseFrame> {
    if (this.#fault) return Promise.reject(this.#fault);
    if (this.#closed) {
      return Promise.reject(new OmoRpcClosedError("OmO RPC Session is closed"));
    }
    const child = this.#child;
    if (!child || !child.stdin.writable) {
      return Promise.reject(
        new OmoRpcFaultError("unavailable", "OmO RPC stdin is unavailable", this.stderrTail),
      );
    }
    const timeoutMs = options.timeoutMs ?? this.#options.commandTimeoutMs;
    const id = `codexhost-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const pending: PendingCommand = { command, resolve, reject, timeout: null };
      this.#pending.set(id, pending);
      pending.timeout = setTimeout(() => {
        pending.timeout = null;
        if (this.#pending.get(id) !== pending) return;
        this.#pending.delete(id);
        this.#rememberExpired(id);
        pending.reject(new OmoRpcCommandTimeoutError(command, timeoutMs));
      }, timeoutMs);
      // id and type come last: payload cannot break correlation.
      const frame = Buffer.from(`${JSON.stringify({ ...payload, id, type: command })}\n`, "utf8");
      child.stdin.write(frame, (error) => {
        if (!error) return;
        if (pending.timeout) {
          clearTimeout(pending.timeout);
          pending.timeout = null;
        }
        if (this.#pending.get(id) === pending) this.#pending.delete(id);
        reject(error);
      });
    });
  }

  /**
   * Forks the active branch before `entryId` into a new Session and returns
   * the refreshed native state. The entry itself is excluded (rpc.md: the
   * "fork" command copies the branch up to that user message). An extension
   * veto surfaces as `OmoRpcForkCancelledError`, never as a silent no-op.
   */
  async fork(entryId: string): Promise<OmoRpcSessionState> {
    if (entryId.length === 0) throw new Error("OmO Fork Entry ID must not be empty");
    const response = await this.send("fork", { entryId });
    const cancelled = isRecord(response.data) && response.data.cancelled === true;
    const state = await this.refreshState();
    if (cancelled) throw new OmoRpcForkCancelledError();
    return state;
  }

  /**
   * Idempotent. The first call ends the event iterator, rejects pending
   * commands with `OmoRpcClosedError`, then ends stdin, waits, and kills the
   * process tree when the engine does not exit on its own. A tree that survives
   * every bounded stage rejects the shared promise with `OmoRpcCloseError`.
   */
  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#rejectAll(new OmoRpcClosedError("OmO RPC Session closed"));
    this.#events.end();
    const cleanup = this.#stopProcess();
    cleanup.catch(() => undefined);
    this.#closePromise = cleanup;
    return cleanup;
  }

  #wire(child: ChildProcessWithoutNullStreams): void {
    child.stdout.on("data", (chunk: Buffer) => this.#push(chunk));
    child.stdout.on("end", () => {
      if (this.#failed || this.#closed) return;
      try {
        this.#framer.finish();
      } catch (error) {
        this.#fail(this.#protocolFault(error));
      }
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.#appendStderr(chunk.toString());
    });
    // A child that exits before reading closes the pipe; without a listener the
    // EPIPE becomes an uncaught exception in the shared Host process.
    child.stdin.on("error", (error) => {
      if (this.#closed) return;
      this.#fail(
        new OmoRpcFaultError(
          "processExited",
          `OmO RPC stdin closed: ${error.message}`,
          this.stderrTail,
          { cause: error },
        ),
      );
    });
    child.on("error", (error) => {
      this.#fail(spawnFault(error, this.stderrTail));
    });
    // `exit` may arrive before the last stdout data and its `end`: the engine
    // can answer its final command and terminate in the same breath. Failing
    // here would gate #push on #failed and lose that answer, so the process-
    // exited fault waits for stdout to drain, bounded by the close budget.
    // #fail stays the one idempotent place the fault is published.
    child.once("exit", (code, signal) => {
      if (this.#closed) return;
      const fail = (): void => {
        if (this.#failed || this.#closed) return;
        this.#fail(
          new OmoRpcFaultError(
            "processExited",
            `OmO RPC exited (code=${code}, signal=${signal})`,
            this.stderrTail,
          ),
        );
      };
      if (child.stdout.readableEnded) {
        fail();
        return;
      }
      const timer = setTimeout(() => {
        child.stdout.off("end", onDrained);
        fail();
      }, this.#options.closeTimeoutMs);
      timer.unref?.();
      function onDrained(): void {
        clearTimeout(timer);
        fail();
      }
      child.stdout.once("end", onDrained);
    });
  }

  #appendStderr(chunk: string): void {
    this.#stderrRaw += chunk;
    if (this.#stderrRaw.length > STDERR_TAIL_MAX_LENGTH) {
      this.#stderrRaw = this.#stderrRaw.slice(-STDERR_TAIL_MAX_LENGTH);
    }
  }

  #push(chunk: Buffer): void {
    if (this.#failed || this.#closed) return;
    let frames: OmoFrame[];
    try {
      frames = this.#framer.push(chunk);
    } catch (error) {
      this.#fail(this.#protocolFault(error));
      return;
    }
    for (const frame of frames) {
      if (isOmoResponseFrame(frame)) this.#handleResponse(frame);
      else if (!isStartupChatter(frame)) this.#events.push(frame);
      if (this.#failed) return;
    }
    // A chunk can complete frames and then fail: they were delivered above, and
    // the failure ends the stream only after their responses resolved.
    const failure = this.#framer.failure;
    if (failure) this.#fail(this.#protocolFault(failure));
  }

  #handleResponse(response: OmoResponseFrame): void {
    const pending = this.#pending.get(response.id);
    if (!pending) {
      if (this.#expired.delete(response.id)) return;
      this.#fail(
        new OmoRpcFaultError(
          "protocolError",
          `OmO RPC response id '${response.id}' is not pending`,
          this.stderrTail,
        ),
      );
      return;
    }
    if (pending.timeout) {
      clearTimeout(pending.timeout);
      pending.timeout = null;
    }
    this.#pending.delete(response.id);
    if (response.success) pending.resolve(response);
    else pending.reject(new OmoRpcResponseError(pending.command, response));
  }

  #rememberExpired(id: string): void {
    this.#expired.add(id);
    if (this.#expired.size > MAX_EXPIRED_IDS) {
      const oldest = this.#expired.values().next().value;
      if (oldest !== undefined) this.#expired.delete(oldest);
    }
  }

  #protocolFault(error: unknown): OmoRpcFaultError {
    if (error instanceof OmoRpcFaultError) return error;
    const detail = error instanceof OmoProtocolError ? `: ${error.message}` : `: ${message(error)}`;
    return new OmoRpcFaultError(
      "protocolError",
      `OmO RPC protocol failure${detail}`,
      this.stderrTail,
      errorOptions(error),
    );
  }

  #startupFault(error: unknown): OmoRpcFaultError {
    if (error instanceof OmoRpcFaultError) return error;
    if (error instanceof OmoRpcCommandTimeoutError) {
      return new OmoRpcFaultError(
        "unavailable",
        `OmO RPC startup timed out: ${error.message}`,
        this.stderrTail,
        { cause: error },
      );
    }
    if (error instanceof OmoRpcResponseError) {
      return new OmoRpcFaultError(
        "protocolError",
        `OmO RPC startup was refused: ${error.message}`,
        this.stderrTail,
        { cause: error },
      );
    }
    return new OmoRpcFaultError(
      "unavailable",
      `OmO RPC startup failed: ${message(error)}`,
      this.stderrTail,
      errorOptions(error),
    );
  }

  #fail(fault: OmoRpcFaultError): void {
    if (this.#failed || this.#closed) return;
    this.#failed = true;
    this.#closed = true;
    this.#fault = fault;
    this.#rejectAll(fault);
    this.#events.end();
    this.#options.onFault?.(fault);
    // A fault must not leave the child writing into a stream nobody reads.
    const cleanup = this.#stopProcess();
    cleanup.catch(() => undefined);
    this.#closePromise ??= cleanup;
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      if (pending.timeout) {
        clearTimeout(pending.timeout);
        pending.timeout = null;
      }
      pending.reject(error);
    }
    this.#pending.clear();
  }

  async #stopProcess(): Promise<void> {
    const child = this.#child;
    if (!child || child.pid === undefined) return;
    // stdin EOF is a clean exit for this engine (live-probed on 5.1.83).
    if (child.stdin.writable) child.stdin.end();
    if (await waitForExit(child, this.#options.closeTimeoutMs)) return;
    if (process.platform === "win32") {
      signalProcessTree(child, "SIGKILL");
      if (!(await waitForExit(child, this.#options.closeTimeoutMs))) {
        throw new OmoRpcCloseError(
          `OmO RPC process tree did not exit within ${this.#options.closeTimeoutMs}ms after taskkill`,
        );
      }
      return;
    }
    signalProcessTree(child, "SIGTERM");
    if (await waitForExit(child, this.#options.closeTimeoutMs)) return;
    signalProcessTree(child, "SIGKILL");
    if (!(await waitForExit(child, this.#options.closeTimeoutMs))) {
      throw new OmoRpcCloseError(
        `OmO RPC process tree did not exit within ${this.#options.closeTimeoutMs}ms after SIGKILL`,
      );
    }
  }
}

/** Signals the whole tree; on Windows taskkill also reaches a `.cmd` child. */
function signalProcessTree(
  child: { readonly pid?: number | undefined },
  signal: NodeJS.Signals,
): void {
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

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    function onExit(): void {
      clearTimeout(timer);
      resolve(true);
    }
    child.once("exit", onExit);
  });
}

/** Resolves once the OS reports a spawned child, bounded by the startup budget. */
function waitForSpawn(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.pid !== undefined) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("spawn", onSpawn);
      child.off("error", onError);
      reject(
        new OmoRpcFaultError("unavailable", `OmO RPC process did not start within ${timeoutMs}ms`),
      );
    }, timeoutMs);
    function onSpawn(): void {
      clearTimeout(timer);
      child.off("error", onError);
      resolve();
    }
    function onError(error: Error): void {
      clearTimeout(timer);
      child.off("spawn", onSpawn);
      reject(error);
    }
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function spawnFault(error: unknown, diagnostic?: string): OmoRpcFaultError {
  if (error instanceof OmoRpcFaultError) return error;
  const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
  return new OmoRpcFaultError(
    code === "ENOENT" ? "notInstalled" : "unavailable",
    `OmO RPC failed to start: ${message(error)}`,
    diagnostic,
    errorOptions(error),
  );
}

function errorOptions(error: unknown): ErrorOptions | undefined {
  return error instanceof Error ? { cause: error } : undefined;
}

function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
