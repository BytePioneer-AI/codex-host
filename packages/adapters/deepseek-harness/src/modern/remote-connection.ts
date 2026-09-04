/** Managed DeepSeek Harness Modern Web Remote transport. */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { StringDecoder } from "node:string_decoder";

import WebSocket from "ws";

import { deepSeekProcessInvocation, killDeepSeekProcessTree } from "../executable.js";

import {
  MODERN_REMOTE_MUX_PATH,
  assertModernStreamEndpoint,
  assertModernUnaryEndpoint,
  parseLaunchUrl,
  parseSessionCookie,
  parseStreamFrame,
  parseUnaryResponse,
  redactModernCredential,
  sanitizeModernRemoteFailure,
  type ModernRemoteFailure,
  type ModernRemoteResult,
  type ModernRemoteStreamFrame,
} from "./wire.js";

export type ModernRemoteConnectionErrorCode =
  | "authenticationRequired"
  | "cancelled"
  | "notInstalled"
  | "processExited"
  | "protocolError"
  | "unavailable";

export class ModernRemoteConnectionError extends Error {
  readonly nativeCode?: string;
  readonly remoteFailure?: ModernRemoteFailure;

  constructor(
    readonly code: ModernRemoteConnectionErrorCode,
    message: string,
    nativeCode?: string,
    remoteFailure?: ModernRemoteFailure,
  ) {
    super(redactModernCredential(message));
    this.name = "ModernRemoteConnectionError";
    if (nativeCode !== undefined) this.nativeCode = redactModernCredential(nativeCode);
    if (remoteFailure) this.remoteFailure = sanitizeModernRemoteFailure(remoteFailure);
  }
}

export interface ModernRemoteConnectionOptions {
  /** Raw resolved executable; `.cmd`/`.bat` wrapping happens after Web args are complete. */
  readonly command: string;
  /** Raw arguments placed before the exact managed Web invocation, such as the npx prefix. */
  readonly commandArguments?: readonly string[];
  readonly environment?: NodeJS.ProcessEnv;
  readonly startupTimeoutMs?: number;
  readonly unaryTimeoutMs?: number;
  readonly streamOpenTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
  readonly maxHttpResponseBytes?: number;
  readonly maxWebSocketPayloadBytes?: number;
  readonly maxQueuedStreamFrames?: number;
  readonly maxQueuedStreamBytes?: number;
  readonly maxReadinessBytes?: number;
  /** Host-owned local browser handoff. Omit for remote Hosts. */
  readonly openWebUi?: (url: URL) => Promise<void>;
}

export interface ModernRemoteCallOptions {
  /** `null` is reserved for lifecycle-owned long operations and requires a caller signal. */
  readonly timeoutMs?: number | null;
}

export interface ModernWebSocket {
  readonly readyState: number;
  on(event: "open" | "close", listener: () => void): this;
  on(event: "message", listener: (data: unknown, isBinary: boolean) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(
    event: "unexpected-response",
    listener: (request: unknown, response: IncomingMessage) => void,
  ): this;
  off(event: "open" | "close", listener: () => void): this;
  off(event: "message", listener: (data: unknown, isBinary: boolean) => void): this;
  off(event: "error", listener: (error: Error) => void): this;
  off(
    event: "unexpected-response",
    listener: (request: unknown, response: IncomingMessage) => void,
  ): this;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

export interface ModernRemoteConnectionDependencies {
  readonly spawn: (
    command: string,
    args: string[],
    options: {
      env: NodeJS.ProcessEnv;
      stdio: "pipe";
      windowsHide: true;
      windowsVerbatimArguments: boolean;
      detached: boolean;
    },
  ) => ChildProcess;
  readonly fetch: (input: URL, init: RequestInit) => Promise<Response>;
  readonly createWebSocket: (url: URL, cookie: string, maxPayloadBytes: number) => ModernWebSocket;
  readonly randomUUID: () => string;
  readonly platform: NodeJS.Platform;
  readonly killProcessTree: (
    child: ChildProcess,
    platform: NodeJS.Platform,
    timeoutMs: number,
  ) => void;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;
const DEFAULT_UNARY_TIMEOUT_MS = 10_000;
const DEFAULT_STREAM_OPEN_TIMEOUT_MS = 10_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_HTTP_RESPONSE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_WEBSOCKET_PAYLOAD_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_QUEUED_STREAM_FRAMES = 4_096;
const DEFAULT_MAX_QUEUED_STREAM_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_READINESS_BYTES = 16 * 1024;
const STDERR_CHUNK_TAIL_MAX_LENGTH = 16 * 1024;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const OPEN = 1;

function positiveSafeInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${name} must be an integer from 1 through ${String(maximum)}`);
  }
  return value;
}

const DEFAULT_DEPENDENCIES: ModernRemoteConnectionDependencies = {
  spawn: (command, args, options) => spawn(command, args, options),
  fetch: (input, init) => globalThis.fetch(input, init),
  createWebSocket: (url, cookie, maxPayloadBytes) =>
    new WebSocket(url, {
      headers: { Cookie: cookie },
      maxPayload: maxPayloadBytes,
    }) as unknown as ModernWebSocket,
  randomUUID,
  platform: process.platform,
  killProcessTree: killDeepSeekProcessTree,
};

type SocketEvent =
  | { readonly type: "frame"; readonly frame: ModernRemoteStreamFrame }
  | { readonly type: "error"; readonly error: Error }
  | { readonly type: "unexpected-response"; readonly statusCode: number | undefined }
  | { readonly type: "close" };

interface TrackedSocket {
  readonly closed: Promise<void>;
  closePromise?: Promise<void>;
  didClose: boolean;
  quiescing: boolean;
  quiesce: () => void;
  release: () => void;
}

class SocketInbox {
  readonly #items: Array<{ readonly event: SocketEvent; readonly bytes: number }> = [];
  #bytes = 0;
  #failure: ModernRemoteConnectionError | undefined;
  #wake: (() => void) | undefined;

  constructor(
    readonly maxFrames: number,
    readonly maxBytes: number,
  ) {}

  push(item: SocketEvent, bytes = 0): boolean {
    if (this.#failure) return false;
    if (this.#items.length + 1 > this.maxFrames || this.#bytes + bytes > this.maxBytes) {
      this.fail(
        new ModernRemoteConnectionError(
          "protocolError",
          "DeepSeek Harness Remote stream exceeded its bounded inbox",
        ),
      );
      return false;
    }
    this.#items.push({ event: item, bytes });
    this.#bytes += bytes;
    this.#wake?.();
    this.#wake = undefined;
    return true;
  }

  fail(error: ModernRemoteConnectionError): void {
    if (this.#failure) return;
    this.#failure = error;
    this.#items.length = 0;
    this.#bytes = 0;
    this.#wake?.();
    this.#wake = undefined;
  }

  async take(): Promise<SocketEvent> {
    while (this.#items.length === 0 && !this.#failure) {
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
    if (this.#failure) throw this.#failure;
    const item = this.#items.shift() as { readonly event: SocketEvent; readonly bytes: number };
    this.#bytes -= item.bytes;
    return item.event;
  }
}

/** One managed Modern process, authenticated HTTP carrier, and its active Remote streams. */
export class ModernRemoteConnection {
  readonly #closeTimeoutMs: number;
  readonly #dependencies: ModernRemoteConnectionDependencies;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #lifetime = new AbortController();
  readonly #options: ModernRemoteConnectionOptions;
  readonly #sockets = new Map<ModernWebSocket, TrackedSocket>();
  readonly #startupTimeoutMs: number;
  readonly #streamOpenTimeoutMs: number;
  readonly #unaryTimeoutMs: number;
  readonly #maxHttpResponseBytes: number;
  readonly #maxWebSocketPayloadBytes: number;
  readonly #maxQueuedStreamFrames: number;
  readonly #maxQueuedStreamBytes: number;
  readonly #maxReadinessBytes: number;
  readonly #faultListeners = new Set<(error: ModernRemoteConnectionError) => void>();
  #child: ChildProcess | undefined;
  #closePromise: Promise<void> | undefined;
  #connectPromise: Promise<void> | undefined;
  #cookie: string | undefined;
  #fault: ModernRemoteConnectionError | undefined;
  #launchUrl: string | undefined;
  #openWebUiPromise: Promise<void> | undefined;
  #origin: URL | undefined;
  #stderrDiscardUntilWhitespace = false;
  #stderrRawCarry = "";
  #stderrTail = "";
  #closing = false;
  #stoppingChild = false;
  #stopPromise: Promise<void> | undefined;

  constructor(
    options: ModernRemoteConnectionOptions,
    dependencies: Partial<ModernRemoteConnectionDependencies> = {},
  ) {
    if (options.command.trim() === "") {
      throw new ModernRemoteConnectionError("notInstalled", "DeepSeek Harness command is missing");
    }
    this.#options = options;
    this.#dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
    this.#environment = options.environment ?? process.env;
    this.#startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.#unaryTimeoutMs = options.unaryTimeoutMs ?? DEFAULT_UNARY_TIMEOUT_MS;
    this.#streamOpenTimeoutMs = options.streamOpenTimeoutMs ?? DEFAULT_STREAM_OPEN_TIMEOUT_MS;
    this.#closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this.#maxHttpResponseBytes = options.maxHttpResponseBytes ?? DEFAULT_MAX_HTTP_RESPONSE_BYTES;
    this.#maxWebSocketPayloadBytes =
      options.maxWebSocketPayloadBytes ?? DEFAULT_MAX_WEBSOCKET_PAYLOAD_BYTES;
    this.#maxQueuedStreamFrames = options.maxQueuedStreamFrames ?? DEFAULT_MAX_QUEUED_STREAM_FRAMES;
    this.#maxQueuedStreamBytes = options.maxQueuedStreamBytes ?? DEFAULT_MAX_QUEUED_STREAM_BYTES;
    this.#maxReadinessBytes = options.maxReadinessBytes ?? DEFAULT_MAX_READINESS_BYTES;
    for (const [name, value] of [
      ["startupTimeoutMs", this.#startupTimeoutMs],
      ["unaryTimeoutMs", this.#unaryTimeoutMs],
      ["streamOpenTimeoutMs", this.#streamOpenTimeoutMs],
      ["closeTimeoutMs", this.#closeTimeoutMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
        throw new TypeError(
          `${name} must be an integer from 1 through ${String(MAX_TIMER_DELAY_MS)}`,
        );
      }
    }
    for (const [name, value] of [
      ["maxHttpResponseBytes", this.#maxHttpResponseBytes],
      ["maxWebSocketPayloadBytes", this.#maxWebSocketPayloadBytes],
      ["maxQueuedStreamFrames", this.#maxQueuedStreamFrames],
      ["maxQueuedStreamBytes", this.#maxQueuedStreamBytes],
      ["maxReadinessBytes", this.#maxReadinessBytes],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`${name} must be a positive safe integer`);
      }
    }
  }

  get stderrTail(): string {
    return this.#stderrTail;
  }

  connect(): Promise<void> {
    if (this.#closing) {
      return Promise.reject(
        new ModernRemoteConnectionError("unavailable", "DeepSeek Harness connection is closing"),
      );
    }
    this.#connectPromise ??= this.#performConnect();
    return this.#connectPromise;
  }

  openWebUi(): Promise<void> {
    if (!this.#options.openWebUi) {
      return Promise.reject(
        new ModernRemoteConnectionError(
          "unavailable",
          "DeepSeek Harness Web is not available on this Host",
        ),
      );
    }
    if (this.#openWebUiPromise) return this.#openWebUiPromise;
    const operation = this.#performOpenWebUi();
    const tracked = operation.finally(() => {
      if (this.#openWebUiPromise === tracked) this.#openWebUiPromise = undefined;
    });
    this.#openWebUiPromise = tracked;
    return tracked;
  }

  onFault(listener: (error: ModernRemoteConnectionError) => void): () => void {
    this.#faultListeners.add(listener);
    const fault = this.#fault;
    if (fault) {
      queueMicrotask(() => {
        if (!this.#faultListeners.has(listener)) return;
        try {
          listener(fault);
        } catch {
          // Late delivery has the same listener isolation as synchronous fault publication.
        }
      });
    }
    return () => {
      this.#faultListeners.delete(listener);
    };
  }

  async call<T>(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    options: ModernRemoteCallOptions = {},
  ): Promise<ModernRemoteResult<T>> {
    if (options.timeoutMs === null && !signal) {
      throw new TypeError("Disabling a DeepSeek Harness Remote timeout requires an AbortSignal");
    }
    if (signal?.aborted) {
      throw new ModernRemoteConnectionError(
        "cancelled",
        "DeepSeek Harness Remote call was cancelled before startup",
      );
    }
    assertModernUnaryEndpoint(endpoint);
    await this.connect();
    const origin = this.#origin as URL;
    const cookie = this.#cookie as string;
    const rpcId = this.#dependencies.randomUUID();
    const timeoutMs =
      options.timeoutMs === undefined
        ? this.#unaryTimeoutMs
        : options.timeoutMs === null
          ? null
          : positiveSafeInteger(options.timeoutMs, "timeoutMs", MAX_TIMER_DELAY_MS);
    const timeout = timeoutMs === null ? undefined : AbortSignal.timeout(timeoutMs);
    const requestSignal = AbortSignal.any([
      this.#lifetime.signal,
      ...(timeout ? [timeout] : []),
      ...(signal ? [signal] : []),
    ]);
    let response: Response;
    try {
      response = await this.#dependencies.fetch(new URL(`/api/${endpoint}`, origin), {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          cookie,
        },
        body: JSON.stringify({
          type: "client-request",
          rpcId,
          method: endpoint,
          payload: { args },
        }),
        signal: requestSignal,
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new ModernRemoteConnectionError(
          "cancelled",
          "DeepSeek Harness Remote call was cancelled",
        );
      }
      if (timeout?.aborted) {
        throw new ModernRemoteConnectionError(
          "unavailable",
          `DeepSeek Harness Remote call ${endpoint} timed out`,
        );
      }
      throw this.#transportFailure(`Remote call ${endpoint} failed`, error);
    }
    if (response.status === 401 || response.status === 403) {
      await cancelResponse(response);
      throw new ModernRemoteConnectionError(
        "authenticationRequired",
        "DeepSeek Harness Web authentication is no longer valid",
      );
    }
    if (response.status >= 300 && response.status < 400) {
      await cancelResponse(response);
      throw new ModernRemoteConnectionError(
        "protocolError",
        "DeepSeek Harness Remote returned an unexpected redirect",
      );
    }
    if (!response.ok) {
      await cancelResponse(response);
      throw new ModernRemoteConnectionError(
        "unavailable",
        `DeepSeek Harness Remote call failed with HTTP ${String(response.status)}`,
      );
    }
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "application/json") {
      await cancelResponse(response);
      throw new ModernRemoteConnectionError(
        "protocolError",
        "DeepSeek Harness Remote returned a non-JSON response",
      );
    }
    let value: unknown;
    try {
      value = await readBoundedJson(response, this.#maxHttpResponseBytes);
    } catch (error) {
      if (signal?.aborted) {
        throw new ModernRemoteConnectionError(
          "cancelled",
          "DeepSeek Harness Remote call was cancelled",
        );
      }
      if (this.#fault) throw this.#fault;
      if (timeout?.aborted) {
        throw new ModernRemoteConnectionError(
          "unavailable",
          `DeepSeek Harness Remote call ${endpoint} timed out`,
        );
      }
      if (error instanceof BoundedResponseProtocolError) {
        throw new ModernRemoteConnectionError(
          "protocolError",
          `DeepSeek Harness Remote returned an invalid response: ${error.message}`,
        );
      }
      throw this.#transportFailure(`Remote call ${endpoint} response body failed`, error);
    }
    try {
      const result = parseUnaryResponse<T>(value, rpcId);
      return result.ok ? result : { ok: false, error: sanitizeModernRemoteFailure(result.error) };
    } catch (error) {
      if (error instanceof ModernRemoteConnectionError) throw error;
      throw new ModernRemoteConnectionError(
        "protocolError",
        `DeepSeek Harness Remote returned an invalid response: ${messageOf(error)}`,
      );
    }
  }

  openStream<T>(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): AsyncIterable<T> {
    if (signal?.aborted) {
      throw new ModernRemoteConnectionError(
        "cancelled",
        "DeepSeek Harness Remote stream was cancelled before startup",
      );
    }
    assertModernStreamEndpoint(endpoint);
    return this.#stream<T>(endpoint, args, signal);
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#performClose();
    return this.#closePromise;
  }

  async *#stream<T>(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    callerSignal?: AbortSignal,
  ): AsyncGenerator<T> {
    if (callerSignal?.aborted) {
      throw new ModernRemoteConnectionError(
        "cancelled",
        "DeepSeek Harness Remote stream was cancelled before startup",
      );
    }
    await this.connect();
    if (callerSignal?.aborted || this.#closing) return;
    if (this.#fault) throw this.#fault;
    const origin = this.#origin as URL;
    const cookie = this.#cookie as string;
    const url = new URL(MODERN_REMOTE_MUX_PATH, origin);
    url.protocol = "ws:";
    const streamId = this.#dependencies.randomUUID();
    let socket: ModernWebSocket;
    try {
      socket = this.#dependencies.createWebSocket(url, cookie, this.#maxWebSocketPayloadBytes);
    } catch (error) {
      throw this.#transportFailure("Remote stream could not open", error);
    }
    const inbox = new SocketInbox(this.#maxQueuedStreamFrames, this.#maxQueuedStreamBytes);
    let transportOpened = false;
    let openSent = false;
    let terminalQueued = false;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const tracking: TrackedSocket = {
      closed,
      didClose: false,
      quiescing: false,
      quiesce: () => undefined,
      release: () => undefined,
    };
    this.#sockets.set(socket, tracking);
    const openTimer = setTimeout(() => {
      if (tracking.quiescing) return;
      inbox.push({
        type: "error",
        error: new Error("DeepSeek Harness Remote stream did not open in time"),
      });
      socket.close();
    }, this.#streamOpenTimeoutMs);
    const onOpen = (): void => {
      clearTimeout(openTimer);
      if (tracking.quiescing) return;
      if (transportOpened) {
        inbox.fail(this.#protocolFailure("Remote stream opened twice"));
        socket.close(1008, "duplicate Remote stream open");
        return;
      }
      transportOpened = true;
      if (socket.readyState !== OPEN) {
        inbox.fail(
          new ModernRemoteConnectionError(
            "unavailable",
            "DeepSeek Harness Remote stream closed before logical open",
          ),
        );
        return;
      }
      try {
        socket.send(JSON.stringify({ type: "open", streamId, endpoint, payload: { args } }));
        openSent = true;
      } catch (error) {
        inbox.fail(this.#transportFailure("Remote stream open failed", error));
        socket.close();
      }
    };
    const onMessage = (data: unknown, isBinary: boolean): void => {
      if (tracking.quiescing) return;
      try {
        if (!openSent) {
          throw this.#protocolFailure(
            "Remote stream emitted a frame before logical open completed",
          );
        }
        if (isBinary) throw this.#protocolFailure("Remote stream emitted a binary frame");
        const bytes = rawByteLength(data);
        const frame = parseStreamFrame(rawText(data));
        if (frame.streamId !== streamId) {
          throw this.#protocolFailure("Remote stream emitted an unexpected stream identity");
        }
        if (terminalQueued) {
          throw this.#protocolFailure("Remote stream emitted a frame after its terminal frame");
        }
        if (frame.type === "end" || frame.type === "error") terminalQueued = true;
        if (!inbox.push({ type: "frame", frame }, bytes)) {
          socket.close(1009, "bounded Remote stream inbox exceeded");
        }
      } catch (error) {
        inbox.fail(this.#protocolFailure(messageOf(error)));
        socket.close(1003, "invalid Remote stream payload");
      }
    };
    const onError = (error: Error): void => {
      if (tracking.quiescing) return;
      inbox.push({ type: "error", error });
    };
    const onUnexpectedResponse = (_request: unknown, response: IncomingMessage): void => {
      response.resume();
      if (tracking.quiescing) {
        socket.terminate();
        return;
      }
      inbox.push({ type: "unexpected-response", statusCode: response.statusCode });
      socket.terminate();
    };
    const onClose = (): void => {
      tracking.didClose = true;
      resolveClosed();
      if (!tracking.quiescing) inbox.push({ type: "close" });
    };
    socket.on("open", onOpen);
    socket.on("message", onMessage);
    socket.on("error", onError);
    socket.on("unexpected-response", onUnexpectedResponse);
    socket.on("close", onClose);
    const quiesce = (): void => {
      clearTimeout(openTimer);
      socket.off("open", onOpen);
      socket.off("message", onMessage);
      socket.off("unexpected-response", onUnexpectedResponse);
    };
    tracking.quiesce = quiesce;
    tracking.release = (): void => {
      quiesce();
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const streamSignal = AbortSignal.any([
      this.#lifetime.signal,
      ...(callerSignal ? [callerSignal] : []),
    ]);
    let terminal = false;
    const abort = (): void => {
      if (openSent && socket.readyState === OPEN) {
        sendBestEffort(socket, { type: "cancel", streamId });
      }
      socket.close();
      inbox.push({ type: "close" });
    };
    streamSignal.addEventListener("abort", abort, { once: true });
    if (streamSignal.aborted) abort();
    try {
      while (true) {
        const event = await inbox.take();
        if (event.type === "error") {
          throw socketFailure(event.error, this.#fault);
        }
        if (event.type === "unexpected-response") {
          throw new ModernRemoteConnectionError(
            event.statusCode === 401 || event.statusCode === 403
              ? "authenticationRequired"
              : "unavailable",
            event.statusCode === 401 || event.statusCode === 403
              ? "DeepSeek Harness Web authentication is no longer valid"
              : `DeepSeek Harness Remote WebSocket upgrade failed with HTTP ${String(event.statusCode ?? "unknown")}`,
          );
        }
        if (event.type === "close") {
          if (callerSignal?.aborted || this.#closing) return;
          if (this.#fault) throw this.#fault;
          throw new ModernRemoteConnectionError(
            "unavailable",
            "DeepSeek Harness Remote stream closed unexpectedly",
          );
        }
        const frame = event.frame;
        if (frame.type === "item") {
          yield frame.value as T;
          continue;
        }
        terminal = true;
        if (frame.type === "end") return;
        throw new ModernRemoteConnectionError(
          "unavailable",
          frame.error.message,
          frame.error.code,
          frame.error,
        );
      }
    } finally {
      streamSignal.removeEventListener("abort", abort);
      quiesce();
      if (openSent && !terminal && socket.readyState === OPEN) {
        sendBestEffort(socket, { type: "cancel", streamId });
      }
      await this.#closeTrackedSocket(socket);
    }
  }

  #closeTrackedSocket(socket: ModernWebSocket): Promise<void> {
    const tracking = this.#sockets.get(socket);
    if (!tracking) return Promise.resolve();
    tracking.closePromise ??= this.#doCloseTrackedSocket(socket, tracking);
    return tracking.closePromise;
  }

  async #doCloseTrackedSocket(socket: ModernWebSocket, tracking: TrackedSocket): Promise<void> {
    tracking.quiescing = true;
    tracking.quiesce();
    let closeFailed = false;
    try {
      socket.close();
    } catch {
      closeFailed = true;
    }
    try {
      if (
        !tracking.didClose &&
        !closeFailed &&
        (await waitForSocketClose(tracking.closed, this.#closeTimeoutMs))
      ) {
        return;
      }
      if (!tracking.didClose) {
        try {
          socket.terminate();
        } catch {
          // The physical close event or the second bound below owns final settlement.
        }
      }
      if (
        !tracking.didClose &&
        !(await waitForSocketClose(tracking.closed, this.#closeTimeoutMs))
      ) {
        throw new ModernRemoteConnectionError(
          "unavailable",
          "DeepSeek Harness Remote stream did not close within cleanup bounds",
        );
      }
    } finally {
      tracking.release();
      this.#sockets.delete(socket);
    }
  }

  async #performConnect(): Promise<void> {
    const rawArguments = [
      ...(this.#options.commandArguments ?? []),
      "web",
      "--no-open",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
    ];
    const invocation = deepSeekProcessInvocation(
      this.#options.command,
      rawArguments,
      this.#environment,
      this.#dependencies.platform,
    );
    let child: ChildProcess;
    try {
      child = this.#dependencies.spawn(invocation.command, invocation.arguments, {
        env: this.#environment,
        stdio: "pipe",
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        detached: this.#dependencies.platform !== "win32",
      });
    } catch (error) {
      throw this.#spawnFailure(error);
    }
    this.#child = child;
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const truncated =
        typeof chunk === "string"
          ? chunk.length > STDERR_CHUNK_TAIL_MAX_LENGTH
          : chunk.byteLength > STDERR_CHUNK_TAIL_MAX_LENGTH;
      let bounded =
        typeof chunk === "string"
          ? chunk.slice(-STDERR_CHUNK_TAIL_MAX_LENGTH)
          : chunk
              .subarray(Math.max(0, chunk.byteLength - STDERR_CHUNK_TAIL_MAX_LENGTH))
              .toString("utf8");
      if (truncated) {
        const boundary = bounded.search(/\s/u);
        this.#stderrRawCarry = "";
        if (boundary < 0) {
          this.#stderrDiscardUntilWhitespace = true;
          return;
        }
        bounded = bounded.slice(boundary + 1);
        this.#stderrDiscardUntilWhitespace = false;
      }
      if (this.#stderrDiscardUntilWhitespace) {
        const boundary = bounded.search(/\s/u);
        if (boundary < 0) return;
        bounded = bounded.slice(boundary + 1);
        this.#stderrDiscardUntilWhitespace = false;
        this.#stderrRawCarry = "";
      }
      let combined = `${this.#stderrRawCarry}${bounded}`;
      if (combined.length > STDERR_CHUNK_TAIL_MAX_LENGTH) {
        combined = combined.slice(-STDERR_CHUNK_TAIL_MAX_LENGTH);
        const boundary = combined.search(/\s/u);
        if (boundary < 0) {
          this.#stderrRawCarry = "";
          this.#stderrDiscardUntilWhitespace = true;
          return;
        }
        combined = combined.slice(boundary + 1);
      }
      this.#stderrRawCarry = combined;
      this.#stderrTail = redactModernCredential(combined);
    });
    child.once("exit", this.#managedExit);
    try {
      const launchUrl = await this.#readinessUrl(child);
      child.on("error", this.#managedError);
      const cookie = await this.#exchangeToken(launchUrl);
      const origin = new URL(launchUrl.origin);
      this.#origin = origin;
      this.#cookie = cookie;
      if (this.#options.openWebUi) this.#launchUrl = launchUrl.href;
      if (this.#fault) throw this.#fault;
    } catch (error) {
      await this.#stopManagedProcess(child);
      if (this.#fault) throw this.#fault;
      if (error instanceof ModernRemoteConnectionError) throw error;
      throw this.#protocolFailure(messageOf(error));
    }
  }

  readonly #managedExit = (): void => {
    if (this.#closing || this.#stoppingChild) return;
    const child = this.#child;
    if (child) {
      // Start tree cleanup in the exit callback, before a stale PID can be reused.
      void this.#stopManagedProcess(child).catch(() => undefined);
    }
    this.#publishFault(
      new ModernRemoteConnectionError("processExited", "DeepSeek Harness Web exited unexpectedly"),
    );
  };

  readonly #managedError = (error: Error): void => {
    if (this.#closing || this.#stoppingChild) return;
    this.#publishFault(this.#spawnFailure(error));
  };

  #readinessUrl(child: ChildProcess): Promise<URL> {
    return new Promise<URL>((resolve, reject) => {
      let buffer = "";
      let bytes = 0;
      let settled = false;
      const decoder = new StringDecoder("utf8");
      const finish = (result: { readonly url: URL } | { readonly error: Error }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.stdout?.off("data", onData);
        child.stdout?.resume();
        child.off("error", onError);
        child.off("exit", onExit);
        this.#lifetime.signal.removeEventListener("abort", onAbort);
        if ("url" in result) resolve(result.url);
        else reject(result.error);
      };
      const inspectLine = (line: string): void => {
        const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
        if (!clean.startsWith("dsh web:")) return;
        try {
          finish({ url: parseLaunchUrl(clean) });
        } catch (error) {
          finish({ error: error as Error });
        }
      };
      const onData = (chunk: Buffer | string): void => {
        const raw = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += raw.byteLength;
        if (bytes > this.#maxReadinessBytes) {
          finish({ error: new Error("Modern DSH Web readiness output exceeded its bound") });
          return;
        }
        buffer += decoder.write(raw);
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline === -1) return;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          inspectLine(line);
          if (settled) return;
        }
      };
      const onError = (error: Error): void => finish({ error: this.#spawnFailure(error) });
      const onExit = (): void =>
        finish({
          error: new ModernRemoteConnectionError(
            "processExited",
            "DeepSeek Harness Web exited before readiness",
          ),
        });
      const onAbort = (): void =>
        finish({
          error: new ModernRemoteConnectionError(
            "cancelled",
            "DeepSeek Harness Web startup was cancelled",
          ),
        });
      const timeout = setTimeout(
        () =>
          finish({
            error: new ModernRemoteConnectionError(
              "unavailable",
              "DeepSeek Harness Web did not become ready in time",
            ),
          }),
        this.#startupTimeoutMs,
      );
      child.stdout?.on("data", onData);
      child.once("error", onError);
      child.once("exit", onExit);
      this.#lifetime.signal.addEventListener("abort", onAbort, { once: true });
      if (this.#lifetime.signal.aborted) onAbort();
      if (child.exitCode !== null || child.signalCode !== null) onExit();
    });
  }

  async #exchangeToken(launchUrl: URL): Promise<string> {
    let response: Response;
    try {
      response = await this.#dependencies.fetch(launchUrl, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.any([
          this.#lifetime.signal,
          AbortSignal.timeout(this.#startupTimeoutMs),
        ]),
      });
    } catch (error) {
      throw this.#transportFailure("DeepSeek Harness Web authentication failed", error);
    }
    if (response.status !== 303 || response.headers.get("location") !== "/") {
      await cancelResponse(response);
      throw new ModernRemoteConnectionError(
        response.status === 401 || response.status === 403
          ? "authenticationRequired"
          : "protocolError",
        "DeepSeek Harness Web rejected its bootstrap authentication exchange",
      );
    }
    try {
      return parseSessionCookie(response.headers, launchUrl.host);
    } catch (error) {
      throw this.#protocolFailure(messageOf(error));
    } finally {
      await cancelResponse(response);
    }
  }

  async #performOpenWebUi(): Promise<void> {
    await this.connect();
    const openWebUi = this.#options.openWebUi;
    const child = this.#child;
    const origin = this.#origin;
    const launchUrl = this.#launchUrl;
    if (
      this.#closing ||
      this.#fault ||
      !child ||
      child.exitCode !== null ||
      child.signalCode !== null ||
      !origin ||
      !launchUrl ||
      !openWebUi
    ) {
      throw new ModernRemoteConnectionError(
        "unavailable",
        "DeepSeek Harness Web is no longer available",
      );
    }
    const verified = parseLaunchUrl(`dsh web: ${launchUrl}`);
    if (verified.origin !== origin.origin) {
      throw new ModernRemoteConnectionError(
        "protocolError",
        "DeepSeek Harness Web launch URL does not belong to the managed process",
      );
    }
    try {
      await openWebUi(verified);
    } catch {
      throw new ModernRemoteConnectionError(
        "unavailable",
        "DeepSeek Harness Web could not be opened",
      );
    }
  }

  async #performClose(): Promise<void> {
    this.#closing = true;
    this.#launchUrl = undefined;
    this.#origin = undefined;
    this.#cookie = undefined;
    this.#lifetime.abort(new Error("DeepSeek Harness connection closed"));
    const socketClosures = [...this.#sockets.keys()].map((socket) =>
      this.#closeTrackedSocket(socket),
    );
    const child = this.#child;
    const stop = child ? this.#stopManagedProcess(child) : Promise.resolve();
    const connect = this.#connectPromise;
    const [stopped, ...remaining] = await Promise.allSettled([
      stop,
      ...socketClosures,
      ...(connect ? [connect] : []),
    ]);
    const socketResults = remaining.slice(0, socketClosures.length);
    this.#faultListeners.clear();
    if (child) {
      child.off("error", this.#managedError);
      child.off("exit", this.#managedExit);
    }
    this.#stderrRawCarry = "";
    this.#stderrDiscardUntilWhitespace = false;
    this.#launchUrl = undefined;
    this.#origin = undefined;
    this.#cookie = undefined;
    if (stopped?.status === "rejected") throw stopped.reason;
    const socketFailure = socketResults.find((result) => result.status === "rejected");
    if (socketFailure?.status === "rejected") throw socketFailure.reason;
  }

  async #stopManagedProcess(child: ChildProcess): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    const stop = this.#doStopManagedProcess(child);
    this.#stopPromise = stop;
    return stop;
  }

  async #doStopManagedProcess(child: ChildProcess): Promise<void> {
    this.#stoppingChild = true;
    const containError = (): void => undefined;
    child.on("error", containError);
    try {
      if (
        this.#dependencies.platform !== "win32" &&
        child.exitCode === null &&
        child.signalCode === null
      ) {
        const gracefulExit = waitForExit(child, this.#closeTimeoutMs);
        child.kill("SIGTERM");
        await gracefulExit;
      }
      try {
        this.#dependencies.killProcessTree(
          child,
          this.#dependencies.platform,
          this.#closeTimeoutMs,
        );
      } catch (error) {
        throw new ModernRemoteConnectionError(
          "unavailable",
          `DeepSeek Harness process tree could not be stopped: ${messageOf(error)}`,
        );
      }
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (await waitForExit(child, this.#closeTimeoutMs)) return;
      throw new ModernRemoteConnectionError(
        "unavailable",
        "DeepSeek Harness process tree did not exit within cleanup bounds",
      );
    } finally {
      child.off("error", containError);
    }
  }

  #publishFault(error: ModernRemoteConnectionError): void {
    if (this.#fault || this.#closing) return;
    this.#fault = error;
    this.#launchUrl = undefined;
    this.#origin = undefined;
    this.#cookie = undefined;
    this.#lifetime.abort(error);
    for (const socket of this.#sockets.keys()) socket.close();
    for (const listener of [...this.#faultListeners]) {
      try {
        listener(error);
      } catch {
        // One subscriber cannot prevent the remaining Sessions from observing the process fault.
      }
    }
  }

  #spawnFailure(error: unknown): ModernRemoteConnectionError {
    const missing =
      typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT";
    return new ModernRemoteConnectionError(
      missing ? "notInstalled" : "unavailable",
      missing
        ? "DeepSeek Harness command is not installed"
        : `DeepSeek Harness Web could not start: ${messageOf(error)}`,
    );
  }

  #transportFailure(message: string, error: unknown): ModernRemoteConnectionError {
    if (this.#fault) return this.#fault;
    return new ModernRemoteConnectionError("unavailable", `${message}: ${messageOf(error)}`);
  }

  #protocolFailure(message: string): ModernRemoteConnectionError {
    return new ModernRemoteConnectionError("protocolError", message);
  }
}

function rawText(data: unknown): string {
  if (typeof data === "string") return data;
  let bytes: Uint8Array;
  if (Buffer.isBuffer(data)) bytes = data;
  else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else if (ArrayBuffer.isView(data)) {
    bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  } else if (Array.isArray(data) && data.every(Buffer.isBuffer)) {
    bytes = Buffer.concat(data as Buffer[]);
  } else {
    throw new TypeError("Modern DSH Web emitted an unsupported Remote stream payload");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError("Modern DSH Web emitted invalid UTF-8 in a Remote stream frame");
  }
}

function rawByteLength(data: unknown): number {
  if (typeof data === "string") return Buffer.byteLength(data);
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (Array.isArray(data) && data.every(Buffer.isBuffer)) {
    return data.reduce((bytes, chunk) => bytes + chunk.byteLength, 0);
  }
  throw new TypeError("Modern DSH Web emitted an unsupported Remote stream payload");
}

async function cancelResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Rejection already owns the request; body cleanup is best-effort and must not replace it.
  }
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const header = response.headers.get("content-length");
  if (header !== null) {
    if (!/^(?:0|[1-9]\d*)$/u.test(header)) {
      await cancelResponse(response);
      throw new BoundedResponseProtocolError(
        "DeepSeek Harness Remote returned an invalid Content-Length",
      );
    }
    if (Number(header) > maxBytes) {
      await cancelResponse(response);
      throw new BoundedResponseProtocolError(
        "DeepSeek Harness Remote response exceeded its byte limit",
      );
    }
  }
  const body = response.body;
  if (!body) {
    throw new BoundedResponseProtocolError(
      "DeepSeek Harness Remote returned an empty JSON response",
    );
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The byte-bound failure owns the result even if transport cleanup also rejects.
        }
        throw new BoundedResponseProtocolError(
          "DeepSeek Harness Remote response exceeded its byte limit",
        );
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes));
  } catch {
    throw new BoundedResponseProtocolError("DeepSeek Harness Remote response was not valid UTF-8");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BoundedResponseProtocolError("DeepSeek Harness Remote response was not valid JSON");
  }
}

class BoundedResponseProtocolError extends Error {}

function socketFailure(
  error: Error,
  processFault: ModernRemoteConnectionError | undefined,
): ModernRemoteConnectionError {
  if (processFault) return processFault;
  const code = Reflect.get(error, "code");
  return new ModernRemoteConnectionError(
    code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH" ? "protocolError" : "unavailable",
    code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
      ? "DeepSeek Harness Remote stream exceeded its WebSocket payload limit"
      : `DeepSeek Harness Remote stream failed: ${error.message}`,
  );
}

function sendBestEffort(socket: ModernWebSocket, value: object): void {
  try {
    socket.send(JSON.stringify(value));
  } catch {
    // A closing carrier already owns cancellation; there is no second recovery action here.
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = (): void => finish(true);
    const timeout = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

function waitForSocketClose(closed: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (didClose: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(didClose);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);
    void closed.then(() => finish(true));
  });
}

export type { ModernRemoteFailure, ModernRemoteResult } from "./wire.js";
