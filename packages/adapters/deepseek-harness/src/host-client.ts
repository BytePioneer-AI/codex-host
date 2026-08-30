import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

import { sanitizeDiagnosticTail } from "@codexhost/harness-adapter";
import type { HostFrame, MuxFrame, RpcRequest } from "@deepseek-ai/dsh-host-apiproxy/api";
import { hostFrameSchema, muxFrameSchema } from "@deepseek-ai/dsh-host-apiproxy/api/events.schema";
import { serverRequestSchema } from "@deepseek-ai/dsh-host-apiproxy/api/rpc.schema";
import { AbstractApiClient, type IApiClient } from "@deepseek-ai/dsh-host-apiproxy/client";

export interface DeepSeekCommandResult {
  commandId: string;
  result:
    { kind: "success"; text?: string; sourceEventSeq?: number } | { kind: "error"; text: string };
}

export type DeepSeekHostClient = IApiClient & {
  commands: {
    execute(input: {
      agentId: string;
      line: string;
      images: readonly [];
    }): Promise<DeepSeekCommandResult>;
  };
};
export type DeepSeekMuxEnvelope = RpcRequest<MuxFrame>;
export type DeepSeekHostEnvelope = RpcRequest<HostFrame>;

export type DeepSeekHarnessTransportErrorCode =
  "notInstalled" | "unavailable" | "protocolError" | "processExited" | "nativeFailure";

export class DeepSeekHarnessTransportError extends Error {
  constructor(
    readonly code: DeepSeekHarnessTransportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DeepSeekHarnessTransportError";
  }
}

type StreamFrame = MuxFrame | HostFrame;
type StreamItem<F> = { type: "frame"; envelope: RpcRequest<F> } | { type: "end" };
type FrameSchema<F> = { parse(value: unknown): F };

type DeepSeekCommandResponse = {
  result:
    | { ok: true; value: DeepSeekCommandResult | undefined }
    | { ok: false; error: { code: string; message: string } };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCommandResponse(value: unknown): value is DeepSeekCommandResponse {
  if (!isRecord(value) || !isRecord(value.result) || typeof value.result.ok !== "boolean") {
    return false;
  }
  if (!value.result.ok) {
    return (
      isRecord(value.result.error) &&
      typeof value.result.error.code === "string" &&
      typeof value.result.error.message === "string"
    );
  }
  if (value.result.value === undefined) return true;
  if (!isRecord(value.result.value) || typeof value.result.value.commandId !== "string") {
    return false;
  }
  const result = value.result.value.result;
  return (
    isRecord(result) &&
    (result.kind === "success" || result.kind === "error") &&
    (result.text === undefined || typeof result.text === "string")
  );
}

export class NodeDeepSeekHostClient extends AbstractApiClient {
  readonly #endpoint: URL;

  constructor(endpoint: string, timeoutMs?: number) {
    super(timeoutMs);
    this.#endpoint = parseLoopbackEndpoint(endpoint);
  }

  protected override resolveBase(): string {
    return this.#endpoint.href;
  }

  protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
    return globalThis.fetch(input, init);
  }

  readonly commands = {
    execute: (input: {
      agentId: string;
      line: string;
      images: readonly [];
    }): Promise<DeepSeekCommandResult> => this.#executeCommand(input),
  };

  async #executeCommand(input: {
    agentId: string;
    line: string;
    images: readonly [];
  }): Promise<DeepSeekCommandResult> {
    const response = await this.doFetch(new URL("/api/commands/execute", this.#endpoint), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "client-request",
        rpcId: `codexhost-${randomUUID()}`,
        method: "commands/execute",
        payload: { args: input },
      }),
    });
    if (!response.ok) {
      throw new DeepSeekHarnessTransportError(
        "unavailable",
        `DeepSeek Harness commands/execute returned HTTP ${response.status}`,
      );
    }
    const envelope: unknown = await response.json();
    if (!isCommandResponse(envelope)) {
      throw new DeepSeekHarnessTransportError(
        "protocolError",
        "DeepSeek Harness commands/execute returned an invalid response",
      );
    }
    if (!envelope.result.ok) {
      throw new DeepSeekHarnessTransportError(
        envelope.result.error.code === "session-not-found" ? "unavailable" : "protocolError",
        `DeepSeek Harness commands/execute failed: ${envelope.result.error.message}`,
      );
    }
    if (!envelope.result.value) {
      throw new DeepSeekHarnessTransportError(
        "protocolError",
        "DeepSeek Harness did not recognize the requested command",
      );
    }
    return envelope.result.value;
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
    const handleMessage = (message: MessageEvent): void => {
      try {
        if (typeof message.data !== "string") throw new Error("binary WebSocket frame");
        const full = serverRequestSchema.parse(JSON.parse(message.data));
        const frame = schema.parse(full.payload);
        this.onEnvelope(full);
        enqueue({ type: "frame", envelope: { rpcId: full.rpcId, payload: frame } });
      } catch (error) {
        failed = new DeepSeekHarnessTransportError(
          "protocolError",
          `DeepSeek Harness emitted an invalid ${pathname} frame: ${error instanceof Error ? error.message : String(error)}`,
        );
        socket.close();
      }
    };
    const handleError = (): void => {
      failed ??= new DeepSeekHarnessTransportError(
        "unavailable",
        `DeepSeek Harness event stream '${pathname}' failed`,
      );
    };
    const handleClose = (): void => enqueue({ type: "end" });
    const handleAbort = (): void => socket.close();
    socket.addEventListener("open", handleOpen);
    socket.addEventListener("message", handleMessage);
    socket.addEventListener("error", handleError);
    socket.addEventListener("close", handleClose, { once: true });
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
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("message", handleMessage);
      socket.removeEventListener("error", handleError);
      socket.removeEventListener("close", handleClose);
      socket.close();
    }
  }
}

export interface DeepSeekHostConnectionOptions {
  command?: string;
  endpoint?: string;
  environment?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  commandTimeoutMs?: number;
  closeTimeoutMs?: number;
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
    },
  ): ChildProcess;
  sleep(milliseconds: number): Promise<void>;
}

export interface DeepSeekHostSubscriber {
  onMux(envelope: DeepSeekMuxEnvelope): void;
  onFault(error: DeepSeekHarnessTransportError): void;
}

const DEFAULT_ENDPOINT = "http://127.0.0.1:3080";
const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 3_000;

function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.entries(environment).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

function parseLoopbackEndpoint(endpoint: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new DeepSeekHarnessTransportError("unavailable", "DeepSeek Harness endpoint is invalid");
  }
  const loopback =
    parsed.hostname === "localhost" ||
    parsed.hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/u.test(parsed.hostname);
  if (!loopback || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw new DeepSeekHarnessTransportError(
      "unavailable",
      "DeepSeek Harness endpoint must use HTTP on loopback",
    );
  }
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed;
}

function executableCandidates(command: string, environment: NodeJS.ProcessEnv): string[] {
  const targetPath = process.platform === "win32" ? path.win32 : path.posix;
  if (targetPath.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return [command];
  }
  const extensions =
    process.platform === "win32" && targetPath.extname(command) === ""
      ? (environmentValue(environment, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .map((extension) => extension.trim())
          .filter(Boolean)
      : [""];
  return (environmentValue(environment, "PATH") ?? "")
    .split(targetPath.delimiter)
    .map((directory) => directory.trim().replace(/^"|"$/gu, ""))
    .filter(Boolean)
    .flatMap((directory) =>
      extensions.map((extension) => targetPath.join(directory, command + extension)),
    );
}

export interface DeepSeekCommandInvocation {
  command: string;
  arguments: string[];
  kind: "configured" | "dsh" | "npx";
}

function resolveExecutable(command: string, environment: NodeJS.ProcessEnv): string | null {
  const accessMode = process.platform === "win32" ? constants.F_OK : constants.X_OK;
  for (const candidate of executableCandidates(command, environment)) {
    try {
      accessSync(candidate, accessMode);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Continue through the configured PATH.
    }
  }
  return null;
}

export function resolveDeepSeekCommand(
  configured: string | undefined,
  environment: NodeJS.ProcessEnv,
): DeepSeekCommandInvocation | null {
  if (configured) {
    const command = resolveExecutable(configured, environment);
    return command ? { command, arguments: [], kind: "configured" } : null;
  }
  const dsh = resolveExecutable("dsh", environment);
  if (dsh) return { command: dsh, arguments: [], kind: "dsh" };
  const npx = resolveExecutable(process.platform === "win32" ? "npx.cmd" : "npx", environment);
  return npx
    ? {
        command: npx,
        arguments: ["--offline", "--no-install", "@deepseek-ai/dsh"],
        kind: "npx",
      }
    : null;
}

export function deepSeekProcessInvocation(
  command: string,
  arguments_: string[],
  environment: NodeJS.ProcessEnv,
  platform = process.platform,
): {
  command: string;
  arguments: string[];
  windowsVerbatimArguments: boolean;
} {
  const extension = path.win32.extname(command).toLowerCase();
  if (platform !== "win32" || ![".cmd", ".bat"].includes(extension)) {
    return { command, arguments: arguments_, windowsVerbatimArguments: false };
  }
  const quote = (value: string): string => `"${value.replaceAll("%", "%%").replaceAll('"', '""')}"`;
  const commandLine = [command, ...arguments_].map(quote).join(" ");
  return {
    command: environmentValue(environment, "ComSpec") ?? "cmd.exe",
    arguments: ["/d", "/v:off", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}

function isMissingExecutableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function unwrap<T>(
  response: { result: { ok: true; value: T } | { ok: false; error: { message: string } } },
  operation: string,
): T {
  if (response.result.ok) return response.result.value;
  throw new DeepSeekHarnessTransportError(
    "unavailable",
    `DeepSeek Harness ${operation} failed: ${response.result.error.message}`,
  );
}

export class DeepSeekHostConnection {
  readonly #client: DeepSeekHostClient;
  readonly #closeTimeoutMs: number;
  readonly #dependencies: DeepSeekHostConnectionDependencies;
  readonly #endpoint: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #options: DeepSeekHostConnectionOptions;
  readonly #startupTimeoutMs: number;
  readonly #subscribers = new Map<string, DeepSeekHostSubscriber>();
  #abort: AbortController | null = null;
  #closePromise: Promise<void> | null = null;
  #connectPromise: Promise<void> | null = null;
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
        }),
      sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    },
  ) {
    this.#options = options;
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

  connect(): Promise<void> {
    if (this.#connectPromise) return this.#connectPromise;
    const attempt = this.#performConnect();
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
    return () => {
      if (this.#subscribers.get(sessionId) === subscriber) this.#subscribers.delete(sessionId);
    };
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#performClose();
    return this.#closePromise;
  }

  async #performConnect(): Promise<void> {
    try {
      await this.#probe();
    } catch (initialError) {
      if (
        initialError instanceof DeepSeekHarnessTransportError &&
        initialError.code === "protocolError"
      ) {
        throw initialError;
      }
      const invocation = resolveDeepSeekCommand(this.#options.command, this.#environment);
      if (!invocation) {
        throw new DeepSeekHarnessTransportError(
          "notInstalled",
          "DeepSeek Harness Web is not running and no local DSH command was found",
        );
      }
      const endpoint = new URL(this.#endpoint);
      const args = [
        ...invocation.arguments,
        "web",
        "--host",
        endpoint.hostname,
        "--port",
        endpoint.port || "80",
      ];
      const processInvocation = deepSeekProcessInvocation(
        invocation.command,
        args,
        this.#environment,
      );
      const child = this.#dependencies.spawn(
        processInvocation.command,
        processInvocation.arguments,
        {
          env: this.#environment,
          stdio: "pipe",
          windowsVerbatimArguments: processInvocation.windowsVerbatimArguments,
        },
      );
      this.#managedProcess = child;
      child.stderr?.on("data", (chunk: Buffer | string) => {
        this.#stderrTail = sanitizeDiagnosticTail(`${this.#stderrTail}${chunk.toString()}`);
      });
      let processError: Error | null = null;
      child.once("error", (error) => {
        processError = error;
      });
      const deadline = Date.now() + this.#startupTimeoutMs;
      for (;;) {
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
          await this.#probe();
          break;
        } catch {
          if (Date.now() >= deadline) {
            throw new DeepSeekHarnessTransportError(
              "unavailable",
              `DeepSeek Harness Web did not become ready at ${this.#endpoint}`,
            );
          }
          await this.#dependencies.sleep(200);
        }
      }
    }
    const abort = new AbortController();
    this.#abort = abort;
    let markOpen = (): void => undefined;
    const opened = new Promise<void>((resolve) => {
      markOpen = resolve;
    });
    this.#pumpPromise = this.#pump(abort.signal, markOpen);
    const ready = await Promise.race([
      opened.then(() => true),
      this.#dependencies.sleep(this.#startupTimeoutMs).then(() => false),
    ]);
    if (!ready) {
      abort.abort();
      throw new DeepSeekHarnessTransportError(
        "unavailable",
        "DeepSeek Harness event stream did not become ready",
      );
    }
  }

  async #probe(): Promise<void> {
    let response: Awaited<ReturnType<DeepSeekHostClient["host"]["describe"]>>;
    try {
      response = await this.#client.host.describe({});
    } catch (error) {
      if (error instanceof TypeError && error.message.toLowerCase().includes("fetch")) throw error;
      throw new DeepSeekHarnessTransportError(
        "protocolError",
        `DeepSeek Harness Host returned an invalid response: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const description = unwrap(response, "host.describe");
    if (description.version !== "0.0.1") {
      throw new DeepSeekHarnessTransportError(
        "protocolError",
        `DeepSeek Harness Host protocol '${description.version}' is incompatible`,
      );
    }
  }

  async #pump(signal: AbortSignal, onOpen: () => void): Promise<void> {
    try {
      for await (const envelope of this.#client.events.mux({}, signal, onOpen)) {
        const frame = envelope.payload;
        if (frame.type === "stream/error") {
          throw new DeepSeekHarnessTransportError(
            "unavailable",
            `DeepSeek Harness event stream failed: ${frame.error.message}`,
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
      for (const subscriber of this.#subscribers.values()) subscriber.onFault(fault);
    }
  }

  async #performClose(): Promise<void> {
    this.#abort?.abort();
    await this.#pumpPromise?.catch(() => undefined);
    this.#subscribers.clear();
    const child = this.#managedProcess;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      this.#dependencies.sleep(this.#closeTimeoutMs),
    ]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}
