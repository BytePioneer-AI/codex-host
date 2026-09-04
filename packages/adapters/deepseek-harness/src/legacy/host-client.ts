import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

import { sanitizeDiagnosticTail } from "@codexhost/harness-adapter";
import type { HostFrame, MuxFrame, RpcError, RpcRequest } from "@deepseek-ai/dsh-host-apiproxy/api";
import { hostFrameSchema, muxFrameSchema } from "@deepseek-ai/dsh-host-apiproxy/api/events.schema";
import {
  serverRequestSchema,
  serverResponseSchema,
} from "@deepseek-ai/dsh-host-apiproxy/api/rpc.schema";
import { AbstractApiClient, type IApiClient } from "@deepseek-ai/dsh-host-apiproxy/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import WebSocket, { type RawData } from "ws";

import {
  deepSeekProcessInvocation,
  killDeepSeekProcessTree,
  resolveDeepSeekCommand,
  type DeepSeekCommandInvocation,
} from "../executable.js";
import {
  DeepSeekGenerationProbeError,
  parseDeepSeekLegacyEndpoint,
} from "../generation-selector.js";
import type { DeepSeekCommandDescriptor } from "../harness-commands.js";
export {
  deepSeekProcessInvocation,
  resolveDeepSeekCommand,
  type DeepSeekCommandInvocation,
} from "../executable.js";
export type { DeepSeekCommandDescriptor } from "../harness-commands.js";

export type DeepSeekHostClient = IApiClient & { readonly commands: DeepSeekCommandClient };
export type DeepSeekMuxEnvelope = RpcRequest<MuxFrame>;
export type DeepSeekHostEnvelope = RpcRequest<HostFrame>;

export interface DeepSeekCommandExecution {
  readonly commandId: string;
  readonly result:
    | { readonly kind: "success"; readonly text?: string; readonly sourceEventSeq?: number }
    | { readonly kind: "error"; readonly text: string };
}

export type DeepSeekCommandResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: RpcError };

export interface DeepSeekCommandClient {
  list(
    sessionId: SessionId,
    signal?: AbortSignal,
  ): Promise<DeepSeekCommandResult<DeepSeekCommandDescriptor[]>>;
  execute(
    sessionId: SessionId,
    line: string,
    signal?: AbortSignal,
  ): Promise<DeepSeekCommandResult<DeepSeekCommandExecution | undefined>>;
}

export type DeepSeekHarnessTransportErrorCode =
  | "authenticationRequired"
  | "cancelled"
  | "notInstalled"
  | "unavailable"
  | "protocolError"
  | "processExited"
  | "nativeFailure";

export class DeepSeekHarnessTransportError extends Error {
  constructor(
    readonly code: DeepSeekHarnessTransportErrorCode,
    message: string,
    readonly nativeCode?: string,
  ) {
    super(message);
    this.name = "DeepSeekHarnessTransportError";
  }
}

type StreamFrame = MuxFrame | HostFrame;
type StreamItem<F> = { type: "frame"; envelope: RpcRequest<F> } | { type: "end" };
type FrameSchema<F> = { parse(value: unknown): F };
const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u;

function commandProtocolError(method: string, detail: string): DeepSeekHarnessTransportError {
  return new DeepSeekHarnessTransportError(
    "protocolError",
    `DeepSeek Harness '${method}' returned ${detail}`,
  );
}

async function rejectLegacyHttpFailure(response: Response): Promise<void> {
  if (response.ok) return;
  await response.body?.cancel().catch(() => undefined);
  if (response.status === 401 || response.status === 403) {
    throw new DeepSeekHarnessTransportError(
      "authenticationRequired",
      "DeepSeek Harness Web requires authentication",
      `HTTP_${String(response.status)}`,
    );
  }
  if (response.status >= 300 && response.status < 400) {
    throw new DeepSeekHarnessTransportError(
      "protocolError",
      "DeepSeek Harness Legacy RPC refused an HTTP redirect",
    );
  }
  throw new DeepSeekHarnessTransportError(
    "protocolError",
    `DeepSeek Harness Legacy RPC failed with HTTP ${String(response.status)}`,
    response.status === 404 ? "HTTP_404" : undefined,
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseCommandDescriptors(value: unknown): DeepSeekCommandDescriptor[] {
  if (!Array.isArray(value)) throw new TypeError("an invalid command catalog");
  const names = new Set<string>();
  const valid = value.every((entry) => {
    const descriptor = record(entry);
    if (
      !descriptor ||
      Object.keys(descriptor).some((key) => !["name", "description", "input"].includes(key)) ||
      typeof descriptor.name !== "string" ||
      !COMMAND_NAME.test(descriptor.name) ||
      names.has(descriptor.name) ||
      typeof descriptor.description !== "string" ||
      descriptor.description.trim().length === 0 ||
      descriptor.description.length > 512
    ) {
      return false;
    }
    names.add(descriptor.name);
    if (descriptor.input === undefined) return true;
    const input = record(descriptor.input);
    return (
      !!input &&
      Object.keys(input).every((key) => key === "hint" || key === "images") &&
      typeof input.hint === "string" &&
      input.hint.trim().length > 0 &&
      input.hint.length <= 512 &&
      (input.images === undefined || typeof input.images === "boolean")
    );
  });
  if (!valid) throw new TypeError("an invalid command catalog");
  return value as DeepSeekCommandDescriptor[];
}

function parseCommandExecution(value: unknown): DeepSeekCommandExecution | undefined {
  if (value === undefined) return undefined;
  const execution = record(value);
  const result = record(execution?.result);
  const validResult =
    !!result &&
    ((result.kind === "error" && typeof result.text === "string") ||
      (result.kind === "success" &&
        (result.text === undefined || typeof result.text === "string") &&
        (result.sourceEventSeq === undefined ||
          (Number.isSafeInteger(result.sourceEventSeq) &&
            (result.sourceEventSeq as number) >= 0))));
  if (!execution || typeof execution.commandId !== "string" || !validResult) {
    throw new TypeError("an invalid command execution");
  }
  return value as DeepSeekCommandExecution;
}

export class NodeDeepSeekHostClient extends AbstractApiClient {
  readonly commands: DeepSeekCommandClient;
  readonly #endpoint: URL;

  constructor(endpoint: string, timeoutMs?: number) {
    super(timeoutMs);
    this.#endpoint = parseLoopbackEndpoint(endpoint);
    this.commands = new NodeDeepSeekCommandClient(endpoint, timeoutMs);
  }

  protected override resolveBase(): string {
    return this.#endpoint.href;
  }

  protected async doFetch(input: URL, init?: RequestInit): Promise<Response> {
    const response = await globalThis.fetch(input, { ...init, redirect: "manual" });
    await rejectLegacyHttpFailure(response);
    return response;
  }

  protected override openMux(
    _payload: Record<string, never>,
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<MuxFrame>> {
    return this.#readWebSocket("/api/events.mux", signal, muxFrameSchema, onOpen);
  }

  protected override openHost(
    _payload: Record<string, never>,
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<HostFrame>> {
    return this.#readWebSocket("/api/events.host", signal, hostFrameSchema, onOpen);
  }

  async *#readWebSocket<F extends StreamFrame>(
    pathname: string,
    signal: AbortSignal,
    schema: FrameSchema<F>,
    onOpen?: () => void,
  ): AsyncGenerator<RpcRequest<F>> {
    const url = new URL(pathname, this.#endpoint);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    const inbox: StreamItem<F>[] = [];
    let wake: (() => void) | undefined;
    let failed: Error | null = null;
    const enqueue = (item: StreamItem<F>): void => {
      inbox.push(item);
      wake?.();
      wake = undefined;
    };
    const handleOpen = (): void => onOpen?.();
    const handleMessage = (data: RawData, isBinary: boolean): void => {
      try {
        if (isBinary) throw new Error("binary WebSocket frame");
        const text = Buffer.isBuffer(data)
          ? data.toString("utf8")
          : Array.isArray(data)
            ? Buffer.concat(data).toString("utf8")
            : Buffer.from(data).toString("utf8");
        const full = serverRequestSchema.parse(JSON.parse(text));
        const frame = schema.parse(full.payload);
        this.onEnvelope(full);
        enqueue({ type: "frame", envelope: { rpcId: full.rpcId, payload: frame } });
      } catch (error) {
        failed = new DeepSeekHarnessTransportError(
          "protocolError",
          `DeepSeek Harness emitted an invalid ${pathname} frame: ${error instanceof Error ? error.message : String(error)}`,
        );
        socket.terminate();
      }
    };
    const handleError = (): void => {
      failed ??= new DeepSeekHarnessTransportError(
        "unavailable",
        `DeepSeek Harness event stream '${pathname}' failed`,
      );
    };
    const handleClose = (): void => enqueue({ type: "end" });
    const handleAbort = (): void => {
      socket.terminate();
      enqueue({ type: "end" });
    };
    socket.on("open", handleOpen);
    socket.on("message", handleMessage);
    socket.on("error", handleError);
    socket.once("close", handleClose);
    signal.addEventListener("abort", handleAbort, { once: true });
    if (signal.aborted) handleAbort();
    try {
      for (;;) {
        while (inbox.length > 0) {
          const item = inbox.shift() as StreamItem<F>;
          if (item.type === "end") {
            if (failed && !signal.aborted) throw failed;
            return;
          }
          yield item.envelope;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      signal.removeEventListener("abort", handleAbort);
      socket.off("open", handleOpen);
      socket.off("message", handleMessage);
      socket.off("error", handleError);
      socket.off("close", handleClose);
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    }
  }
}

export class NodeDeepSeekCommandClient implements DeepSeekCommandClient {
  readonly #endpoint: URL;
  readonly #timeoutMs: number;

  constructor(endpoint: string, timeoutMs = 5_000) {
    this.#endpoint = parseLoopbackEndpoint(endpoint);
    this.#timeoutMs = timeoutMs;
  }

  list(
    sessionId: SessionId,
    signal?: AbortSignal,
  ): Promise<DeepSeekCommandResult<DeepSeekCommandDescriptor[]>> {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    return this.#call(
      "commands/list",
      { agentId: sessionId },
      parseCommandDescriptors,
      signal ? AbortSignal.any([signal, timeout]) : timeout,
    );
  }

  execute(
    sessionId: SessionId,
    line: string,
    signal?: AbortSignal,
  ): Promise<DeepSeekCommandResult<DeepSeekCommandExecution | undefined>> {
    return this.#call(
      "commands/execute",
      { agentId: sessionId, line, images: [] },
      parseCommandExecution,
      signal,
    );
  }

  async #call<T>(
    method: string,
    args: Record<string, unknown>,
    parse: (value: unknown) => T,
    signal?: AbortSignal,
  ): Promise<DeepSeekCommandResult<T>> {
    const rpcId = randomUUID();
    const response = await globalThis.fetch(new URL(`/api/${method}`, this.#endpoint), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId, method, payload: { args } }),
      ...(signal ? { signal } : {}),
      redirect: "manual",
    });
    await rejectLegacyHttpFailure(response);
    let envelope: ReturnType<typeof serverResponseSchema.parse>;
    try {
      envelope = serverResponseSchema.parse(await response.json());
    } catch (error) {
      throw commandProtocolError(
        method,
        `an invalid response: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (envelope.rpcId !== rpcId) {
      throw new DeepSeekHarnessTransportError(
        "protocolError",
        `DeepSeek Harness '${method}' returned an unexpected RPC identity`,
      );
    }
    if (!envelope.result.ok) return envelope.result;
    try {
      return { ok: true, value: parse(envelope.result.value) };
    } catch (error) {
      throw commandProtocolError(method, error instanceof Error ? error.message : String(error));
    }
  }
}

export interface DeepSeekHostConnectionOptions {
  command?: string;
  /** Selector-owned resolved command; prevents a second PATH lookup after the exact version Gate. */
  commandInvocation?: DeepSeekCommandInvocation;
  endpoint?: string;
  environment?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  commandTimeoutMs?: number;
  closeTimeoutMs?: number;
  /** Probe an existing Host only; never start a process when the endpoint is unavailable. */
  attachOnly?: boolean;
}

export interface DeepSeekHostConnectionDependencies {
  createClient(endpoint: string, timeoutMs?: number): DeepSeekHostClient;
  spawn(
    command: string,
    args: string[],
    options: {
      env: NodeJS.ProcessEnv;
      stdio: "pipe";
      windowsVerbatimArguments?: boolean;
      detached: boolean;
    },
  ): ChildProcess;
  sleep(milliseconds: number): Promise<void>;
  platform?: NodeJS.Platform;
  killProcessTree?(child: ChildProcess, platform: NodeJS.Platform, timeoutMs: number): void;
}

export interface DeepSeekHostSubscriber {
  onMux(envelope: DeepSeekMuxEnvelope): void;
  onFault(error: DeepSeekHarnessTransportError): void;
}

const DEFAULT_ENDPOINT = "http://127.0.0.1:3080";
const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 3_000;

function parseLoopbackEndpoint(endpoint: string): URL {
  try {
    return new URL(parseDeepSeekLegacyEndpoint(endpoint));
  } catch (error) {
    if (error instanceof DeepSeekGenerationProbeError) {
      throw new DeepSeekHarnessTransportError(
        error.code === "authenticationRequired" ? "authenticationRequired" : "protocolError",
        error.message,
      );
    }
    throw error;
  }
}

function isMissingExecutableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function unwrapProbe<T>(
  response: { result: { ok: true; value: T } | { ok: false; error: { message: string } } },
  operation: string,
): T {
  if (response.result.ok) return response.result.value;
  throw new DeepSeekHarnessTransportError(
    "protocolError",
    `DeepSeek Harness ${operation} did not satisfy the exact 0.1.1-rc.2 wire contract`,
  );
}

function abortableDelay(delay: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(
      new DeepSeekHarnessTransportError("cancelled", "DeepSeek Harness connection was cancelled"),
    );
  }
  let rejectAborted: ((reason: unknown) => void) | undefined;
  const onAbort = (): void => {
    rejectAborted?.(
      new DeepSeekHarnessTransportError("cancelled", "DeepSeek Harness connection was cancelled"),
    );
  };
  const aborted = new Promise<void>((_, reject) => {
    rejectAborted = reject;
    signal.addEventListener("abort", onAbort, { once: true });
  });
  if (signal.aborted) onAbort();
  return Promise.race([delay, aborted]).finally(() => signal.removeEventListener("abort", onAbort));
}

async function waitForStreamReadiness(
  opened: Promise<void>,
  startupFault: Promise<never>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<"opened" | "timedOut" | "aborted"> {
  let timeout: NodeJS.Timeout | undefined;
  let resolveAborted: (() => void) | undefined;
  const timedOut = new Promise<"timedOut">((resolve) => {
    timeout = setTimeout(() => resolve("timedOut"), timeoutMs);
  });
  const aborted = new Promise<"aborted">((resolve) => {
    resolveAborted = () => resolve("aborted");
    signal.addEventListener("abort", resolveAborted, { once: true });
  });
  if (signal.aborted) resolveAborted?.();
  try {
    return await Promise.race([
      opened.then(() => "opened" as const),
      startupFault,
      timedOut,
      aborted,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (resolveAborted) signal.removeEventListener("abort", resolveAborted);
  }
}

function waitForProcessExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (exited: boolean): void => {
      clearTimeout(timeout);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = (): void => finish(true);
    const timeout = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

async function waitForOperations(
  operations: readonly Promise<void>[],
  timeoutMs: number,
): Promise<void> {
  if (operations.length === 0) return;
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.allSettled(operations),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export class DeepSeekHostConnection {
  readonly #client: DeepSeekHostClient;
  readonly #closeTimeoutMs: number;
  readonly #dependencies: DeepSeekHostConnectionDependencies;
  readonly #endpoint: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #lifetime = new AbortController();
  readonly #options: DeepSeekHostConnectionOptions;
  readonly #platform: NodeJS.Platform;
  readonly #killProcessTree: NonNullable<DeepSeekHostConnectionDependencies["killProcessTree"]>;
  readonly #startupTimeoutMs: number;
  readonly #subscribers = new Map<string, DeepSeekHostSubscriber>();
  #abort: AbortController | null = null;
  #closePromise: Promise<void> | null = null;
  #closed = false;
  #connectPromise: Promise<void> | null = null;
  #fault: DeepSeekHarnessTransportError | null = null;
  #managedProcess: ChildProcess | null = null;
  #stderrTail = "";
  #pumpPromise: Promise<void> | null = null;

  constructor(
    options: DeepSeekHostConnectionOptions = {},
    dependencies: DeepSeekHostConnectionDependencies = {
      createClient: (endpoint, timeoutMs) => new NodeDeepSeekHostClient(endpoint, timeoutMs),
      spawn: (command, args, spawnOptions) =>
        spawn(command, args, {
          env: spawnOptions.env,
          stdio: spawnOptions.stdio,
          windowsHide: true,
          windowsVerbatimArguments: spawnOptions.windowsVerbatimArguments,
          detached: spawnOptions.detached,
        }),
      sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
      platform: process.platform,
      killProcessTree: killDeepSeekProcessTree,
    },
  ) {
    this.#options = options;
    this.#platform = dependencies.platform ?? process.platform;
    this.#killProcessTree = dependencies.killProcessTree ?? killDeepSeekProcessTree;
    this.#environment = options.environment ?? process.env;
    this.#endpoint = parseLoopbackEndpoint(options.endpoint ?? DEFAULT_ENDPOINT).href;
    this.#startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.#closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this.#dependencies = dependencies;
    this.#client = dependencies.createClient(
      this.#endpoint,
      options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    );
  }

  get client(): DeepSeekHostClient {
    return this.#client;
  }

  get stderrTail(): string {
    return this.#stderrTail;
  }

  connect(signal?: AbortSignal): Promise<void> {
    if (this.#closed) {
      return Promise.reject(
        new DeepSeekHarnessTransportError("unavailable", "DeepSeek Harness connection is closing"),
      );
    }
    if (this.#fault) return Promise.reject(this.#fault);
    if (this.#connectPromise) return this.#connectPromise;
    const lifetime = signal
      ? AbortSignal.any([signal, this.#lifetime.signal])
      : this.#lifetime.signal;
    const attempt = this.#performConnect(lifetime);
    this.#connectPromise = attempt;
    void attempt.catch(() => {
      if (this.#connectPromise === attempt) this.#connectPromise = null;
    });
    return attempt;
  }

  subscribe(sessionId: string, subscriber: DeepSeekHostSubscriber): () => void {
    if (this.#subscribers.has(sessionId)) {
      throw new DeepSeekHarnessTransportError(
        "protocolError",
        `DeepSeek Harness Session '${sessionId}' is already attached`,
      );
    }
    this.#subscribers.set(sessionId, subscriber);
    const fault = this.#fault;
    if (fault) {
      queueMicrotask(() => {
        if (this.#subscribers.get(sessionId) === subscriber) subscriber.onFault(fault);
      });
    }
    return () => {
      if (this.#subscribers.get(sessionId) === subscriber) this.#subscribers.delete(sessionId);
    };
  }

  close(): Promise<void> {
    if (!this.#closePromise) {
      this.#closed = true;
      this.#lifetime.abort(new Error("DeepSeek Harness connection closed"));
      this.#closePromise = this.#performClose();
    }
    return this.#closePromise;
  }

  async #performConnect(signal: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new DeepSeekHarnessTransportError(
        "cancelled",
        "DeepSeek Harness connection was cancelled",
      );
    }
    try {
      await this.#probe(signal);
    } catch (initialError) {
      if (signal.aborted || this.#closed) {
        throw new DeepSeekHarnessTransportError(
          "cancelled",
          "DeepSeek Harness connection was cancelled",
        );
      }
      if (
        this.#options.attachOnly ||
        (initialError instanceof DeepSeekHarnessTransportError &&
          (initialError.code === "protocolError" ||
            initialError.code === "authenticationRequired" ||
            initialError.code === "cancelled"))
      ) {
        throw initialError;
      }
      const invocation =
        this.#options.commandInvocation ??
        resolveDeepSeekCommand(this.#options.command, this.#environment);
      if (!invocation) {
        throw new DeepSeekHarnessTransportError(
          "notInstalled",
          "DeepSeek Harness Web is not running and no local DSH command was found",
        );
      }
      const endpoint = new URL(this.#endpoint);
      if (endpoint.protocol === "https:") {
        throw new DeepSeekHarnessTransportError(
          "unavailable",
          "DeepSeek Harness Legacy managed Web requires an HTTP endpoint",
        );
      }
      const args = [
        ...invocation.arguments,
        "web",
        "--no-open",
        "--host",
        endpoint.hostname === "[::1]" ? "::1" : endpoint.hostname,
        "--port",
        endpoint.port || "80",
      ];
      const processInvocation = deepSeekProcessInvocation(
        invocation.command,
        args,
        this.#environment,
        this.#platform,
      );
      const child = this.#dependencies.spawn(
        processInvocation.command,
        processInvocation.arguments,
        {
          env: this.#environment,
          stdio: "pipe",
          windowsVerbatimArguments: processInvocation.windowsVerbatimArguments,
          detached: this.#platform !== "win32",
        },
      );
      this.#managedProcess = child;
      child.stderr?.on("data", (chunk: Buffer | string) => {
        this.#stderrTail = sanitizeDiagnosticTail(`${this.#stderrTail}${chunk.toString()}`);
      });
      child.stdout?.on("data", () => {
        // Legacy readiness is proven by the rc.2 endpoint; continuously drain this pipe.
      });
      let processError: Error | null = null;
      child.once("error", (error) => {
        processError = error;
      });
      const deadline = Date.now() + this.#startupTimeoutMs;
      for (;;) {
        if (signal?.aborted) {
          throw new DeepSeekHarnessTransportError(
            "cancelled",
            "DeepSeek Harness connection was cancelled",
          );
        }
        if (processError) {
          if (isMissingExecutableError(processError)) {
            throw new DeepSeekHarnessTransportError(
              "notInstalled",
              "DeepSeek Harness command is not installed",
            );
          }
          throw new DeepSeekHarnessTransportError(
            "unavailable",
            `DeepSeek Harness Web could not start: ${String(processError)}`,
          );
        }
        if (child.exitCode !== null || child.signalCode !== null) {
          if (invocation.kind === "npx") {
            throw new DeepSeekHarnessTransportError(
              "notInstalled",
              "DeepSeek Harness package is not installed",
            );
          }
          throw new DeepSeekHarnessTransportError(
            "processExited",
            "DeepSeek Harness Web exited during startup",
          );
        }
        try {
          await this.#probe(signal);
          break;
        } catch (error) {
          const retryableManagedProbe =
            error instanceof DeepSeekHarnessTransportError &&
            (error.code === "unavailable" ||
              (error.code === "protocolError" && error.nativeCode === "HTTP_404"));
          if (!retryableManagedProbe) throw error;
          if (Date.now() >= deadline) {
            if (error.code === "protocolError") throw error;
            throw new DeepSeekHarnessTransportError(
              "unavailable",
              `DeepSeek Harness Web did not become ready at ${this.#endpoint}`,
            );
          }
          await abortableDelay(this.#dependencies.sleep(200), signal);
        }
      }
    }
    if (signal.aborted || this.#closed) {
      throw new DeepSeekHarnessTransportError(
        "cancelled",
        "DeepSeek Harness connection was cancelled",
      );
    }
    const abort = new AbortController();
    this.#abort = abort;
    let markOpen = (): void => undefined;
    const opened = new Promise<void>((resolve) => {
      markOpen = (): void => {
        // Defer readiness one event-loop turn so an iterator that opens and immediately ends
        // cannot be mistaken for a live event stream.
        setImmediate(() => {
          if (!signal?.aborted) resolve();
        });
      };
    });
    let markStartupFault: (error: DeepSeekHarnessTransportError) => void = () => undefined;
    const startupFault = new Promise<never>((_resolve, reject) => {
      markStartupFault = reject;
    });
    if (signal?.aborted) {
      abort.abort();
      throw new DeepSeekHarnessTransportError(
        "cancelled",
        "DeepSeek Harness connection was cancelled",
      );
    }
    if (this.#fault) throw this.#fault;
    this.#pumpPromise = this.#pump(abort.signal, markOpen, markStartupFault);
    const readiness = await waitForStreamReadiness(
      opened,
      startupFault,
      this.#startupTimeoutMs,
      signal,
    );
    if (readiness !== "opened") {
      abort.abort();
      if (readiness === "aborted") {
        throw new DeepSeekHarnessTransportError(
          "cancelled",
          "DeepSeek Harness connection was cancelled",
        );
      }
      throw new DeepSeekHarnessTransportError(
        "protocolError",
        "DeepSeek Harness Legacy event stream did not satisfy the exact 0.1.1-rc.2 contract",
      );
    }
    if (signal?.aborted) {
      abort.abort();
      throw new DeepSeekHarnessTransportError(
        "cancelled",
        "DeepSeek Harness connection was cancelled",
      );
    }
  }

  async #probe(signal: AbortSignal): Promise<void> {
    let observedResponse = false;
    try {
      const response = await this.#client.host.describe({}, signal);
      observedResponse = true;
      const description = unwrapProbe(response, "host.describe");
      if (description.version !== "0.0.1") {
        throw new DeepSeekHarnessTransportError(
          "protocolError",
          "DeepSeek Harness Host did not expose the exact 0.1.1-rc.2 Host protocol",
        );
      }
      unwrapProbe(await this.#client.llm.models({}, signal), "llm.models");
      unwrapProbe(await this.#client.settings.describe({}, signal), "settings.describe");
      unwrapProbe(await this.#client.sessions.list({}, signal), "sessions.list");
    } catch (error) {
      if (error instanceof DeepSeekHarnessTransportError) throw error;
      if (signal?.aborted) {
        throw new DeepSeekHarnessTransportError(
          "cancelled",
          "DeepSeek Harness Legacy endpoint probe was cancelled",
        );
      }
      if (
        !observedResponse &&
        error instanceof Error &&
        ((error instanceof TypeError && error.message.toLowerCase().includes("fetch")) ||
          error.name === "TimeoutError" ||
          error.name === "AbortError")
      ) {
        throw new DeepSeekHarnessTransportError(
          "unavailable",
          "DeepSeek Harness Legacy endpoint is unavailable",
        );
      }
      throw new DeepSeekHarnessTransportError(
        "protocolError",
        "DeepSeek Harness Host did not satisfy the exact 0.1.1-rc.2 wire contract",
      );
    }
  }

  async #pump(
    signal: AbortSignal,
    onOpen: () => void,
    onStartupFault: (error: DeepSeekHarnessTransportError) => void,
  ): Promise<void> {
    try {
      for await (const envelope of this.#client.events.mux({}, signal, () => {
        onOpen();
      })) {
        const frame = envelope.payload;
        if (frame.type === "stream/error") {
          throw new DeepSeekHarnessTransportError(
            "unavailable",
            "DeepSeek Harness Legacy event stream failed",
          );
        }
        if ("sessionId" in frame) this.#subscribers.get(frame.sessionId)?.onMux(envelope);
      }
      if (!signal.aborted) {
        throw new DeepSeekHarnessTransportError(
          "unavailable",
          "DeepSeek Harness event stream closed",
        );
      }
    } catch (error) {
      if (signal.aborted) return;
      const fault =
        error instanceof DeepSeekHarnessTransportError
          ? error
          : new DeepSeekHarnessTransportError(
              "unavailable",
              error instanceof Error ? error.message : String(error),
            );
      this.#fault = fault;
      onStartupFault(
        fault.code === "unavailable"
          ? new DeepSeekHarnessTransportError(
              "protocolError",
              "DeepSeek Harness Legacy event stream did not satisfy the exact 0.1.1-rc.2 contract",
            )
          : fault,
      );
      for (const subscriber of this.#subscribers.values()) subscriber.onFault(fault);
    }
  }

  async #performClose(): Promise<void> {
    this.#abort?.abort();
    await waitForOperations(
      [this.#connectPromise, this.#pumpPromise].filter(
        (promise): promise is Promise<void> => promise !== null,
      ),
      this.#closeTimeoutMs,
    );
    this.#subscribers.clear();
    const child = this.#managedProcess;
    if (!child) return;
    if (this.#platform !== "win32" && child.exitCode === null && child.signalCode === null) {
      const gracefulExit = waitForProcessExit(child, this.#closeTimeoutMs);
      child.kill("SIGTERM");
      await gracefulExit;
    }
    try {
      this.#killProcessTree(child, this.#platform, this.#closeTimeoutMs);
    } catch {
      throw new DeepSeekHarnessTransportError(
        "unavailable",
        "DeepSeek Harness Legacy process tree could not be stopped",
      );
    }
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (await waitForProcessExit(child, this.#closeTimeoutMs)) return;
    throw new DeepSeekHarnessTransportError(
      "unavailable",
      "DeepSeek Harness Legacy process tree did not exit within cleanup bounds",
    );
  }
}
