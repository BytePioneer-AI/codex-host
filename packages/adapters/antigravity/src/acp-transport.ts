import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";

import {
  ClientSideConnection,
  ndJsonStream,
  type AnyMessage,
  type Client,
  type InitializeResponse,
  type JsonRpcId,
} from "@agentclientprotocol/sdk";
import { sanitizeDiagnosticTail } from "@codexhost/harness-adapter";
import { commandInvocation as antigravityInvocation } from "@codexhost/harness-discovery";

import { projectAcpSessionUpdate } from "./acp-projection.js";
import { resolveAntigravityExecutable } from "./command.js";
import {
  AntigravityTransportError,
  type AntigravityAcpConfigOption,
  type AntigravityAcpEvent,
  type AntigravityAcpSessionOpenResult,
  type AntigravityAcpTransportLike,
  type AntigravityAcpTransportOptions,
  type AntigravityActivePromptHandler,
  type AntigravityOpenAcpSessionInput,
  type AntigravityPromptInputPart,
  type AntigravityPromptResult,
  type AntigravitySessionEventHandler,
} from "./acp-types.js";

export class AntigravityAcpTransport implements AntigravityAcpTransportLike {
  readonly skipPermissions: boolean;
  #child: ChildProcessWithoutNullStreams | null = null;
  #connection: ClientSideConnection | null = null;
  #initializing: Promise<InitializeResponse> | null = null;
  #sessionId: string | null = null;
  #sessionHandler: AntigravitySessionEventHandler | null = null;
  #active: AntigravityActivePromptHandler | null = null;
  #promptRequestId: JsonRpcId | undefined;
  #callbacks = new Set<() => void>();
  #acceptedCallbacks = new WeakSet<object>();
  #acceptCallbacks = false;
  #promptInterrupted: AbortController | null = null;
  #opening: Array<{ sessionId: string; event: AntigravityAcpEvent }> | null = null;
  #pendingEvents: AntigravityAcpEvent[] = [];
  #closed = false;
  #closing: Promise<void> | null = null;
  #stderrRaw = "";
  get #stderr(): string {
    return sanitizeDiagnosticTail(this.#stderrRaw);
  }
  #faultSignal = new AbortController();

  constructor(private readonly options: AntigravityAcpTransportOptions) {
    this.skipPermissions = options.skipPermissions === true;
  }

  get sessionId(): string | null {
    return this.#sessionId;
  }
  get isClosed(): boolean {
    return this.#closed;
  }

  setSessionEventHandler(handler: AntigravitySessionEventHandler | null): void {
    this.#sessionHandler = handler;
    if (handler) for (const event of this.#pendingEvents.splice(0)) handler(event);
  }

  initialize(): Promise<InitializeResponse> {
    if (this.#closed)
      return Promise.reject(
        new AntigravityTransportError("unavailable", "Antigravity ACP is closed"),
      );
    return (this.#initializing ??= this.#start());
  }

  async #start(): Promise<InitializeResponse> {
    try {
      const executable = resolveAntigravityExecutable(this.options);
      if (!executable)
        throw new AntigravityTransportError("notInstalled", "Antigravity CLI was not found");
      const invocation = antigravityInvocation(
        executable,
        this.skipPermissions ? ["acp", "--dangerously-skip-permissions"] : ["acp"],
        this.options.environment ?? process.env,
      );
      const child = spawn(invocation.command, invocation.arguments, {
        cwd: this.options.cwd,
        env: this.options.environment ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      });
      this.#child = child;
      child.stderr.on("data", (chunk: Buffer) => {
        this.#stderrRaw = (this.#stderrRaw + chunk.toString()).slice(-32_000);
      });
      child.on("error", (error: NodeJS.ErrnoException) =>
        this.#fault(
          new AntigravityTransportError(
            error.code === "ENOENT" ? "notInstalled" : "unavailable",
            error.message,
            { diagnostic: this.#stderr },
          ),
        ),
      );
      child.on("exit", (code, signal) =>
        this.#fault(
          new AntigravityTransportError(
            "processExited",
            `Antigravity ACP exited (code ${code}, signal ${signal})`,
            { diagnostic: this.#stderr },
          ),
        ),
      );
      child.stdin.on("error", (error) => this.#fault(this.#error(error)));
      const stream = ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        // Keep draining ACP stdout even when the consumer is slow.
        Readable.toWeb(child.stdout, {
          strategy: { highWaterMark: Infinity },
        }) as ReadableStream<Uint8Array>,
      );
      const writer = stream.writable.getWriter();
      stream.writable = new WritableStream<AnyMessage>({
        write: (message) => {
          if ("method" in message && message.method === "session/prompt" && "id" in message)
            this.#promptRequestId = message.id;
          return writer.write(message);
        },
        close: () => writer.close(),
        abort: (reason) => writer.abort(reason),
      });
      // agy extends the SDK's tool/permission/form shapes (args, allow_session,
      // and oneOf array items). Dispatch those incoming payloads through the SDK's
      // extension handlers so its standard schemas do not discard native fields.
      const nativeMethods = new Set(["session/request_permission", "elicitation/create"]);
      const extensionPrefix = "_antigravity/";
      stream.readable = stream.readable.pipeThrough(
        new TransformStream({
          transform: (message, controller) => {
            if ("method" in message && message.method === "session/update") {
              const params = message.params as {
                sessionId: string;
                update: Record<string, unknown>;
              };
              // Consume updates in wire order: the SDK may resolve a response before
              // queued notification handlers, dropping the tail of prompt output.
              this.#update(params.sessionId, params.update);
              return;
            }
            if ("method" in message && typeof message.method === "string") {
              const method = message.method.startsWith(extensionPrefix)
                ? message.method.slice(extensionPrefix.length)
                : message.method;
              if (nativeMethods.has(method)) {
                message.method = extensionPrefix + method;
                // Admit callbacks in wire order even if the SDK dispatches them later.
                if (
                  this.#acceptCallbacks &&
                  "id" in message &&
                  typeof message.params === "object" &&
                  message.params !== null
                )
                  this.#acceptedCallbacks.add(message.params);
              }
            }
            if (
              !("method" in message) &&
              "id" in message &&
              message.id === this.#promptRequestId &&
              ("result" in message || "error" in message)
            ) {
              // The next update is idle output, even if the SDK has not settled prompt().
              this.#promptRequestId = undefined;
              this.#acceptCallbacks = false;
              this.#active?.onResponse?.();
            }
            controller.enqueue(message);
          },
        }),
      );
      const onElicitation: NonNullable<Client["unstable_createElicitation"]> = (request) =>
        this.#callback(request, (handler) => handler.onElicitation(request), { action: "cancel" });
      const client: Client = {
        sessionUpdate: ({ sessionId, update }) =>
          this.#update(sessionId, update as Record<string, unknown>),
        requestPermission: (request) =>
          this.#callback(request, (handler) => handler.onPermission(request), {
            outcome: { outcome: "cancelled" },
          }),
        unstable_createElicitation: onElicitation,
        extMethod: async (method, params) => {
          if (method === "_antigravity/session/request_permission")
            return (await client.requestPermission(
              params as Parameters<Client["requestPermission"]>[0],
            )) as unknown as Record<string, unknown>;
          if (method === "_antigravity/elicitation/create")
            return (await onElicitation(
              params as Parameters<NonNullable<Client["unstable_createElicitation"]>>[0],
            )) as unknown as Record<string, unknown>;
          throw new AntigravityTransportError(
            "unsupported",
            `Unsupported ACP client method: ${method}`,
          );
        },
      };
      const connection = new ClientSideConnection(() => client, stream);
      this.#connection = connection;
      connection.signal.addEventListener(
        "abort",
        () =>
          this.#fault(
            new AntigravityTransportError("processExited", "Antigravity ACP connection closed", {
              diagnostic: this.#stderr,
            }),
          ),
        { once: true },
      );
      const response = await this.#request(
        connection.initialize({
          protocolVersion: 1,
          clientCapabilities: { elicitation: { form: {} } },
        }),
        "initialize",
      );
      if (response.protocolVersion !== 1)
        throw new AntigravityTransportError(
          "protocolError",
          `Unsupported ACP version ${response.protocolVersion}`,
        );
      return response;
    } catch (error) {
      await this.close();
      throw this.#error(error);
    }
  }

  async openSession(
    input: AntigravityOpenAcpSessionInput,
  ): Promise<{ opened: AntigravityAcpSessionOpenResult }> {
    await this.initialize();
    if (this.#closed || !this.#connection || this.#active || this.#opening || this.#sessionId)
      throw new AntigravityTransportError(
        "unavailable",
        "Close the current ACP session before opening another",
      );
    const connection = this.#connection;
    const buffered: Array<{ sessionId: string; event: AntigravityAcpEvent }> = [];
    this.#opening = buffered;
    this.#pendingEvents = [];
    const params = {
      cwd: input.cwd,
      mcpServers: [],
      ...(input.additionalDirectories?.length
        ? { additionalDirectories: input.additionalDirectories }
        : {}),
      ...(input.systemPromptAppend
        ? { _meta: { antigravity: { systemPrompt: { append: input.systemPromptAppend } } } }
        : {}),
    };
    try {
      let request: Promise<unknown>;
      if (input.kind === "create") request = connection.newSession(params);
      else {
        if (!input.sessionId)
          throw new AntigravityTransportError("protocolError", "Session ID required for resume");
        request = connection.resumeSession({ ...params, sessionId: input.sessionId });
      }
      const result = await this.#request(
        request,
        `session/${input.kind === "create" ? "new" : input.kind}`,
      );
      const raw = result as unknown as Omit<AntigravityAcpSessionOpenResult, "sessionId"> & {
        sessionId?: string;
        _meta?: { antigravity?: { tier?: AntigravityAcpSessionOpenResult["tier"] } };
      };
      const sessionId = raw.sessionId ?? input.sessionId;
      if (!sessionId)
        throw new AntigravityTransportError(
          "protocolError",
          "Antigravity session/new returned no sessionId",
        );
      this.#sessionId = sessionId;
      for (const entry of buffered) if (entry.sessionId === sessionId) this.#dispatch(entry.event);
      return {
        opened: {
          sessionId,
          ...(raw.models ? { models: raw.models } : {}),
          ...(raw.modes ? { modes: raw.modes } : {}),
          ...(raw.configOptions ? { configOptions: raw.configOptions } : {}),
          ...(raw._meta?.antigravity?.tier ? { tier: raw._meta.antigravity.tier } : {}),
        },
      };
    } finally {
      this.#opening = null;
    }
  }

  async setMode(modeId: string): Promise<void> {
    const { connection, sessionId } = this.#session();
    await this.#request(connection.setSessionMode({ sessionId, modeId }), "session/set_mode");
  }

  async setConfigOption(configId: string, value: string): Promise<AntigravityAcpConfigOption[]> {
    const { connection, sessionId } = this.#session();
    const response = await this.#request(
      connection.setSessionConfigOption({ sessionId, configId, value }),
      "session/set_config_option",
    );
    return response.configOptions as AntigravityAcpConfigOption[];
  }

  async prompt(
    parts: readonly AntigravityPromptInputPart[],
    handler: AntigravityActivePromptHandler,
  ): Promise<AntigravityPromptResult> {
    const { connection, sessionId } = this.#session();
    if (this.#active)
      throw new AntigravityTransportError("unavailable", "An ACP prompt is already active");
    this.#active = handler;
    this.#acceptCallbacks = true;
    const interrupted = new AbortController();
    this.#promptInterrupted = interrupted;
    try {
      return await this.#request(
        connection.prompt({ sessionId, prompt: [...parts] }) as Promise<AntigravityPromptResult>,
        "session/prompt",
        null,
        interrupted.signal,
      );
    } finally {
      this.#clearCallbacks();
      this.#acceptCallbacks = false;
      this.#active = null;
      this.#promptRequestId = undefined;
      this.#promptInterrupted = null;
    }
  }

  async cancel(): Promise<void> {
    const { connection, sessionId } = this.#session();
    this.#acceptCallbacks = false;
    this.#clearCallbacks();
    await this.#request(connection.cancel({ sessionId }), "session/cancel");
  }

  #clearSessionState(): string | null {
    const sessionId = this.#sessionId;
    this.#sessionId = null;
    this.#acceptCallbacks = false;
    this.#promptInterrupted?.abort(
      new AntigravityTransportError("unavailable", "ACP session closed"),
    );
    this.#active = null;
    this.#promptRequestId = undefined;
    this.#pendingEvents = [];
    this.#clearCallbacks();
    return sessionId;
  }

  async closeSession(): Promise<void> {
    const sessionId = this.#clearSessionState();
    if (sessionId && this.#connection)
      await this.#request(
        this.#connection.closeSession({ sessionId }),
        "session/close",
        this.options.closeTimeoutMs ?? 2000,
      );
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    return (this.#closing = this.#shutdown());
  }

  async #shutdown(): Promise<void> {
    // End stdin without sending session/close: in agy ACP, session/close
    // force-cancels any background tasks and subagents owned by the conversation.
    this.#clearSessionState();
    this.#faultSignal.abort(new AntigravityTransportError("unavailable", "Antigravity ACP closed"));
    this.#opening = null;
    this.#sessionHandler = null;
    const child = this.#child;
    if (child && child.exitCode === null && child.signalCode === null && child.pid) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      const timeout = this.options.closeTimeoutMs ?? 2000;
      const term = setTimeout(() => child.kill("SIGTERM"), Math.max(1, timeout / 2));
      const kill = setTimeout(() => child.kill("SIGKILL"), Math.max(2, timeout));
      child.stdin.end();
      try {
        await exited;
      } finally {
        clearTimeout(term);
        clearTimeout(kill);
      }
    }
    this.#connection = null;
    this.#child = null;
  }

  #session(): { connection: ClientSideConnection; sessionId: string } {
    if (this.#closed || !this.#connection || !this.#sessionId)
      throw new AntigravityTransportError("unavailable", "Antigravity ACP session is unavailable");
    return { connection: this.#connection, sessionId: this.#sessionId };
  }

  #update(sessionId: string, raw: Record<string, unknown>): void {
    if (this.#closed) return;
    const event = projectAcpSessionUpdate(raw);
    if (!event) return;
    if (this.#opening) {
      this.#opening.push({ sessionId, event });
      return;
    }
    if (sessionId === this.#sessionId) this.#dispatch(event);
  }

  #dispatch(event: AntigravityAcpEvent): void {
    if (
      ["config.update", "mode.update", "commands.update", "session.info", "usage.context"].includes(
        event.type,
      ) ||
      // The wire request bounds foreground updates; the handler may still
      // be present to let the SDK finish processing earlier callbacks.
      (this.#promptRequestId === undefined && !this.#opening)
    ) {
      if (this.#sessionHandler) this.#sessionHandler(event);
      else this.#pendingEvents.push(event);
    } else this.#active?.onEvent(event);
  }

  async #callback<T>(
    request: object,
    invoke: (handler: AntigravityActivePromptHandler) => Promise<T>,
    cancelled: T,
  ): Promise<T> {
    const active = this.#active;
    if (
      !active ||
      !this.#acceptedCallbacks.delete(request) ||
      !("sessionId" in request) ||
      request.sessionId !== this.#sessionId ||
      this.#closed
    )
      return cancelled;
    let cancel!: () => void;
    const cancellation = new Promise<T>((resolve) => {
      cancel = () => resolve(cancelled);
    });
    this.#callbacks.add(cancel);
    try {
      return await Promise.race([invoke(active), cancellation]);
    } finally {
      this.#callbacks.delete(cancel);
    }
  }

  #clearCallbacks(): void {
    this.#acceptedCallbacks = new WeakSet();
    for (const cancel of this.#callbacks) cancel();
    this.#callbacks.clear();
  }

  async #request<T>(
    promise: Promise<T>,
    operation: string,
    timeoutMs: number | null = this.options.commandTimeoutMs ?? 30_000,
    signal?: AbortSignal,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    let abort!: () => void;
    const signals = [this.#faultSignal.signal, ...(signal ? [signal] : [])];
    const interrupted = new Promise<never>((_, reject) => {
      abort = () => reject(signal?.aborted ? signal.reason : this.#faultSignal.signal.reason);
      if (signals.some((candidate) => candidate.aborted)) abort();
      else
        for (const candidate of signals) candidate.addEventListener("abort", abort, { once: true });
      if (timeoutMs !== null)
        timer = setTimeout(
          () =>
            reject(
              new AntigravityTransportError(
                "unavailable",
                `${operation} timed out after ${timeoutMs}ms`,
                { diagnostic: this.#stderr },
              ),
            ),
          timeoutMs,
        );
    });
    try {
      return await Promise.race([promise, interrupted]);
    } catch (error) {
      const normalized = this.#error(error);
      // An unanswered request has an uncertain native outcome; retire this process
      // instead of allowing its eventual response to affect another session.
      if (normalized.kind === "unavailable" && normalized.message.includes("timed out"))
        void this.close();
      throw normalized;
    } finally {
      clearTimeout(timer);
      for (const candidate of signals) candidate.removeEventListener("abort", abort);
    }
  }

  #error(error: unknown): AntigravityTransportError {
    if (error instanceof AntigravityTransportError) return error;
    const message = sanitizeDiagnosticTail(error instanceof Error ? error.message : String(error));
    const code = (error as { code?: number } | null)?.code;
    return new AntigravityTransportError(
      code === -32000 || /auth|login|sign[ -]?in|unauthenticated/iu.test(message)
        ? "authenticationRequired"
        : "unavailable",
      message,
      { cause: error, diagnostic: this.#stderr },
    );
  }

  #fault(error: AntigravityTransportError): void {
    if (this.#closed || this.#faultSignal.signal.aborted) return;
    this.#faultSignal.abort(error);
    this.#clearCallbacks();
    void this.close();
    this.options.onFault?.(error);
  }
}
