import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { ZcodeError } from "./errors.js";
import { record, text } from "./protocol.js";
import { resolveInstallation, type ZcodeInstallation } from "./installation.js";
import { accountConfig, providerRuntimeHeaders } from "./account.js";
import { DEFAULT_TIMEOUT_MS, nativeCall, type CallContext, type NativeMethod } from "./methods.js";
import type { ZcodeVerifier } from "./verification/index.js";

const MAX_LINE_BYTES = 64 * 1024 * 1024;
// Strict result schema in the CLI; AskUserQuestion waits for the Host user instead of timing out.
const RUNTIME_PREFERENCES = {
  nativeSearchEnhancementsEnabled: true,
  memoryEnabled: false,
  askUserQuestionAutoResolutionEnabled: false,
  modelContextBudgetStrategy: "preflight-v1",
};

export interface TransportOptions {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  /** ZCode.app location saved as the plugin launch path. */
  app?: string;
  timeoutMs?: number;
  /** The Host's shared verifier for this installation; the transport never closes it. */
  verifier: (appVersion: string) => ZcodeVerifier;
}
type Listener = (value: unknown) => void;

/** One installed-CLI `app-server --stdio` process serving one workspace Session. */
export class CliTransport {
  readonly clientId = `codexhost-${randomUUID()}`;
  readonly locator = { backend: "local-service" };
  onFault: ((error: Error) => void) | undefined;
  #child: ChildProcessWithoutNullStreams | undefined;
  #installation!: ZcodeInstallation;
  #context: CallContext;
  #nextId = 0;
  #pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >();
  #sessionListeners = new Map<Listener, string>();
  #frameListeners = new Set<Listener>();
  // The CLI re-announces a waiting interaction under new RPC ids; report each business id once.
  #reportedInteractions = new Set<string>();
  // Aborting these cancels only this transport's running and queued shared verifications.
  #headerRequests = new Map<string, AbortController>();
  #startPlan = false;
  #fault: Error | undefined;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  /** The version of the ZCode.app this process runs from. */
  get appVersion() {
    return this.#installation.version;
  }
  /** Whether the signed-in ZCode account contributed Start Plan providers. */
  get startPlan() {
    return this.#startPlan;
  }
  constructor(readonly options: TransportOptions) {
    this.#context = {
      workspace: { workspacePath: options.cwd, workspaceKey: options.cwd },
      connectionId: `codexhost-${randomUUID()}`,
    };
  }

  async start() {
    if (this.#child || this.#closed)
      throw new ZcodeError("invalidState", "ZCode transport already started or closed");
    const installation = await resolveInstallation(this.options.environment, this.options.app);
    const account = await accountConfig(installation, this.options.environment);
    this.#installation = installation;
    this.#startPlan = Object.keys(account.providers).length > 0;
    // ZCode Desktop runs its Agent CLI on its own Electron build as Node; the CLI's native
    // plugin modules are built for that runtime. Its tool children inherit the variable, as there.
    const child = spawn(
      installation.runtime,
      [installation.cli, "app-server", "--stdio", "--surface", "desktop"],
      {
        cwd: this.options.cwd,
        env: {
          ...this.options.environment,
          ELECTRON_RUN_AS_NODE: "1",
          ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: installation.builtinProviderConfig,
          ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: installation.personalProviderConfig,
        },
        stdio: "pipe",
        windowsHide: true,
        detached: process.platform !== "win32",
      },
    );
    this.#child = child;
    child.stderr.resume();
    child.on("error", () => this.#fail(new ZcodeError("unavailable", "Could not start ZCode")));
    child.on("exit", (code) => {
      if (!this.#closed && !this.#closePromise)
        this.#fail(new ZcodeError("processExited", `ZCode exited (${code ?? "signal"})`));
    });
    child.stdin.on("error", () => {
      if (!this.#closed && !this.#closePromise)
        this.#fail(new ZcodeError("processExited", "ZCode input closed"));
    });
    // Split raw bytes on LF only: UTF-8 continuation bytes never equal 0x0a, while readline
    // would also split on U+2028/U+2029 inside model text.
    let parts: Buffer[] = [];
    let lineBytes = 0;
    const tooLarge = () =>
      this.#fail(new ZcodeError("protocolError", "ZCode message exceeded 64 MiB"));
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.#fault || this.#closed) return;
      let start = 0;
      let index: number;
      while ((index = chunk.indexOf(0x0a, start)) >= 0) {
        lineBytes += index - start;
        if (lineBytes > MAX_LINE_BYTES) return tooLarge();
        parts.push(chunk.subarray(start, index));
        const line = Buffer.concat(parts, lineBytes).toString("utf8");
        parts = [];
        lineBytes = 0;
        start = index + 1;
        try {
          this.#receive(record(JSON.parse(line)));
        } catch {
          this.#fail(new ZcodeError("protocolError", "Invalid ZCode protocol message"));
        }
      }
      lineBytes += chunk.length - start;
      if (lineBytes > MAX_LINE_BYTES) return tooLarge();
      if (start < chunk.length) parts.push(chunk.subarray(start));
    });
    try {
      // app-server accepts account overlays only from its host; publish before any Session work.
      const received = record(await this.#call("provider/updateAccountConfig", account));
      if (received.receivedRevision !== account.revision)
        throw new ZcodeError("protocolError", "ZCode did not accept the account configuration");
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  #receive(message: Record<string, unknown>) {
    if (this.#closed || this.#fault) return;
    if (typeof message.method === "string") {
      if (message.id === undefined) this.#notification(message.method, record(message.params));
      else if (typeof message.id === "string" || typeof message.id === "number")
        void this.#answer(message.id, message.method, record(message.params));
      else throw new Error("Invalid request id");
      return;
    }
    if (typeof message.id !== "number") throw new Error("Invalid response id");
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      // Native error text may echo request data; report only the numeric protocol code.
      const code = record(message.error).code;
      const kind =
        code === -32601
          ? "unsupported"
          : code === -32602
            ? "invalidRequest"
            : code === -32004
              ? "sessionNotFound"
              : code === -32010
                ? "sessionBusy"
                : "nativeFailure";
      pending.reject(
        new ZcodeError(
          kind,
          `ZCode rejected the operation (${String(code)})`,
          kind === "sessionBusy",
        ),
      );
    } else if (Object.hasOwn(message, "result")) pending.resolve(message.result);
    else pending.reject(new ZcodeError("protocolError", "ZCode response has no result"));
  }

  #notification(method: string, params: Record<string, unknown>) {
    if (method === "interaction/providerRuntimeHeadersCancelled")
      this.#headerRequests.get(text(params.requestId))?.abort();
    else if (method === "session/event")
      this.#emitSession(params.sessionId, { type: "session.event", event: params });
    else if (method === "state.updated")
      this.#emitSession(params.sessionId, { type: "state.updated", notification: params });
    else if (method === "v4/conversation/frame")
      for (const listener of this.#frameListeners) listener(params);
  }

  #emitSession(sessionId: unknown, value: unknown) {
    for (const [listener, id] of this.#sessionListeners) if (id === sessionId) listener(value);
  }

  async #answer(id: string | number, method: string, params: Record<string, unknown>) {
    const reply = (body: { result: unknown } | { error: { code: number; message: string } }) =>
      this.#write({ id, ...body });
    if (method === "session/requestRuntimePreferences") reply({ result: RUNTIME_PREFERENCES });
    else if (
      method === "interaction/requestPermission" ||
      method === "interaction/requestUserInput"
    ) {
      // Never answered here: the Session resolves it through v4/command resolveInteraction.
      const requestId = text(params.requestId);
      if (this.#reportedInteractions.has(requestId)) return;
      this.#reportedInteractions.add(requestId);
      this.#emitSession(params.sessionId, {
        type:
          method === "interaction/requestPermission" ? "permission.request" : "userInput.request",
        request: params,
      });
    } else if (method === "interaction/requestProviderRuntimeHeaders") {
      const requestId = text(params.requestId);
      const controller = new AbortController();
      this.#headerRequests.set(requestId, controller);
      try {
        reply({
          result: await providerRuntimeHeaders(
            params.accountAccess,
            controller.signal,
            this.#installation,
            this.options.environment,
            () => this.options.verifier(this.#installation.version),
          ),
        });
      } finally {
        this.#headerRequests.delete(requestId);
      }
    } else if (method === "interaction/requestOfficialMcpAuthHeaders")
      reply({ result: { ok: false, reason: "official_auth_unavailable" } });
    else if (method === "interaction/browserList") reply({ result: { browsers: [] } });
    else if (method === "interaction/browserExecute")
      reply({
        result: {
          ok: false,
          error: { code: "backend_unavailable", message: "codexhost has no ZCode browser" },
          elapsedMs: 0,
        },
      });
    // automation/* and offPeak/* included: codexhost enables neither tool surface.
    else reply({ error: { code: -32601, message: "Method not supported by codexhost" } });
  }

  #write(message: unknown) {
    if (this.#closed || this.#fault || !this.#child) return;
    this.#child.stdin.write(JSON.stringify(message) + "\n");
  }

  #call(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (!this.#child || this.#closed || this.#fault)
      return Promise.reject(this.#fault ?? new ZcodeError("invalidState", "ZCode is closed"));
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.#fail(
            new ZcodeError("unavailable", "ZCode request timed out; delivery is unconfirmed"),
          ),
        timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      this.#pending.set(id, { resolve, reject, timer });
      this.#write({ id, method, params });
    });
  }

  request(method: NativeMethod, params: Record<string, unknown> = {}): Promise<unknown> {
    const call = nativeCall(method, params, this.#context);
    return this.#call(call.method, call.params, call.timeoutMs);
  }

  async listen(
    event: "onDynamicSessionEvent" | "onDynamicConversationFrame",
    params: Record<string, unknown>,
    listener: Listener,
  ) {
    if (event === "onDynamicConversationFrame") {
      this.#frameListeners.add(listener);
      return async () => {
        this.#frameListeners.delete(listener);
      };
    }
    // session/subscribe also marks the Session as streamed, which keeps its runtime resident.
    this.#sessionListeners.set(listener, text(params.sessionId));
    try {
      const result = record(await this.#call("session/subscribe", params));
      if (Array.isArray(result.events))
        for (const event of result.events) listener({ type: "session.event", event });
    } catch (error) {
      this.#sessionListeners.delete(listener);
      throw error;
    }
    return async () => {
      this.#sessionListeners.delete(listener);
    };
  }

  async command(
    sessionId: string | null,
    type: string,
    payload: unknown,
    commandId: string = randomUUID(),
    base?: { revision: number; logEpoch: string },
  ) {
    // sendText acknowledges only after the native TurnStarted is committed.
    const result = record(
      await this.#call("v4/command", {
        commandId,
        clientId: this.clientId,
        sessionId,
        type,
        payload,
        issuedAt: Date.now(),
        ...(base ? { baseRevision: base.revision, baseLogEpoch: base.logEpoch } : {}),
      }),
    );
    if (result.status !== "accepted") {
      const reason = text(result.reasonCode);
      const code = /^[A-Za-z][A-Za-z0-9_.-]{0,160}$/u.test(reason) ? `: ${reason}` : "";
      throw new ZcodeError(
        result.status === "stale" ? "sessionBusy" : "nativeFailure",
        `ZCode rejected ${type} (${text(result.status)}${code})`,
        result.status === "stale",
      );
    }
    return result;
  }

  #fail(error: Error) {
    if (this.#fault || this.#closed) return;
    this.#fault = error;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.onFault?.(error);
    void this.close();
  }

  close(): Promise<void> {
    return (this.#closePromise ??= this.#close());
  }

  async #close() {
    const child = this.#child;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ZcodeError("invalidState", "ZCode closed"));
    }
    this.#pending.clear();
    this.#sessionListeners.clear();
    this.#frameListeners.clear();
    for (const controller of this.#headerRequests.values()) controller.abort();
    if (!child) return;
    const wait = async (ms: number) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          child.off("exit", finish);
          resolve();
        };
        const timer = setTimeout(finish, ms);
        child.once("exit", finish);
      });
    };
    child.stdin.end();
    await wait(5000);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await wait(5000);
    }
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      if (process.platform === "win32") {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        await new Promise<void>((resolve) => {
          killer.once("exit", () => resolve());
          killer.once("error", () => resolve());
        });
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
      await wait(2000);
    }
    child.stdout.destroy();
    child.stderr.destroy();
    child.stdin.destroy();
  }
}
