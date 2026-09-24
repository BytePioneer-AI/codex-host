import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  type NewSessionResponse,
  type LoadSessionResponse,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { devinInvocation } from "./command.js";
import { devinApiKey } from "./credentials.js";

/** Devin's agent-type auth method; accepts `_meta.api_key` in place of its PKCE flow. */
const DEVIN_API_KEY_AUTH_METHOD = "devin-browser";
const REPLAY_LIMIT = 100_000;

export interface DevinTransportOptions {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  command?: string;
  timeoutMs?: number;
}
export type DevinSessionInfo = NewSessionResponse | LoadSessionResponse;
export interface DevinCallbacks {
  update(value: SessionNotification): void;
  permission(value: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  extension(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  notification?(method: string, params: Record<string, unknown>): void;
}
export class DevinTransport {
  sessionId = "";
  replay: SessionNotification[] = [];
  #child: ChildProcessWithoutNullStreams | undefined;
  #connection: ClientSideConnection | undefined;
  #callbacks: DevinCallbacks | undefined;
  #collecting = false;
  #replayOverflow = false;
  #closed = false;
  #fault: Error | undefined;
  #rejectFault!: (error: Error) => void;
  readonly #failed = new Promise<never>((_, reject) => {
    this.#rejectFault = reject;
  });

  constructor(readonly options: DevinTransportOptions) {
    void this.#failed.catch(() => undefined);
  }

  async #bounded<T>(work: Promise<T>, timeout = this.options.timeoutMs ?? 30_000): Promise<T> {
    if (this.#fault) throw this.#fault;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        this.#failed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error("Devin ACP request timed out"));
            void this.close();
          }, timeout);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async #connect(requiresLoadSession: boolean): Promise<ClientSideConnection> {
    const invocation = devinInvocation(this.options.environment, this.options.command);
    const child = spawn(invocation.command, invocation.arguments, {
      cwd: this.options.cwd,
      env: this.options.environment,
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      stdio: "pipe",
      ...(process.platform === "win32" ? {} : { detached: true }),
    });
    this.#child = child;
    const fault = (message: string) => {
      this.#fault = new Error(message);
      this.#rejectFault(this.#fault);
    };
    child.on("error", () => fault("Devin ACP process could not start"));
    child.on("exit", (code) => fault(`Devin ACP process exited (${code ?? "signal"})`));
    child.stderr.resume(); // Native diagnostics may contain secrets; never copy them to Host events.
    this.#connection = new ClientSideConnection(
      () => ({
        sessionUpdate: (value) => {
          if (this.sessionId && value.sessionId !== this.sessionId) return;
          if (this.#callbacks) this.#callbacks.update(value);
          else if (this.#collecting) {
            // The SDK swallows notification handler errors, so record overflow for the caller.
            if (this.replay.length < REPLAY_LIMIT) this.replay.push(value);
            else this.#replayOverflow = true;
          }
        },
        requestPermission: (value) =>
          this.#callbacks && value.sessionId === this.sessionId
            ? this.#callbacks.permission(value)
            : Promise.resolve({ outcome: { outcome: "cancelled" } }),
        extMethod: (method, params) =>
          this.#callbacks
            ? this.#callbacks.extension(method, params)
            : Promise.reject(new Error(`Devin extension ${method} is not supported`)),
        extNotification: async (method, params) => {
          this.#callbacks?.notification?.(method, params);
        },
      }),
      ndJsonStream(
        Writable.toWeb(child.stdin),
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      ),
    );
    try {
      const init = await this.#bounded(
        this.#connection.initialize({
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: "codexhost", version: "0.9.0" },
        }),
      );
      if (
        init.protocolVersion !== 1 ||
        (requiresLoadSession && !init.agentCapabilities?.loadSession)
      )
        throw new Error("Devin does not support the required ACP session protocol");
      // Devin 3000.11+ requires an explicit authenticate call carrying the API
      // key in _meta.api_key on its browser method, which then skips PKCE.
      // Without a key, never trigger the browser flow implicitly — let the
      // following request surface authenticationRequired instead.
      const authMethod = init.authMethods?.find(
        (method) => method.id === DEVIN_API_KEY_AUTH_METHOD,
      )?.id;
      const apiKey = authMethod ? await devinApiKey(this.options.environment) : undefined;
      if (authMethod && apiKey)
        await this.#bounded(
          this.#connection.authenticate({ methodId: authMethod, _meta: { api_key: apiKey } }),
        );
      return this.#connection;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async open(sessionId?: string): Promise<DevinSessionInfo> {
    if (this.#closed || this.#connection) throw new Error("Devin transport cannot be reopened");
    const connection = await this.#connect(Boolean(sessionId));
    try {
      this.sessionId = sessionId ?? "";
      this.#collecting = true;
      const info = await (sessionId
        ? this.#bounded(
            connection.loadSession({ sessionId, cwd: this.options.cwd, mcpServers: [] }),
          )
        : this.#bounded(connection.newSession({ cwd: this.options.cwd, mcpServers: [] })));
      this.#collecting = false;
      this.#assertReplayComplete();
      if ("sessionId" in info && typeof info.sessionId === "string")
        this.sessionId = info.sessionId;
      if (!this.sessionId) throw new Error("Devin returned no native session ID");
      return info;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  /** One-shot sessionless connection for read-only queries like session/list. */
  async probe(): Promise<ClientSideConnection> {
    if (this.#closed || this.#connection) throw new Error("Devin transport cannot be reopened");
    return this.#connect(false);
  }

  /**
   * Devin locks a Native Session to one process, so snapshot reads re-replay
   * through this same connection instead of spawning a second `devin acp`.
   */
  async reload(): Promise<SessionNotification[]> {
    if (!this.#connection || this.#closed || !this.sessionId)
      throw new Error("Devin session is not open");
    this.replay = [];
    this.#replayOverflow = false;
    this.#collecting = true;
    try {
      await this.#bounded(
        this.#connection.loadSession({
          sessionId: this.sessionId,
          cwd: this.options.cwd,
          mcpServers: [],
        }),
      );
    } finally {
      this.#collecting = false;
    }
    this.#assertReplayComplete();
    return this.replay;
  }

  #assertReplayComplete() {
    if (this.#replayOverflow) throw new Error("Devin replay exceeds the supported history limit");
  }

  async configure(configId: string, value: string) {
    if (!this.#connection) throw new Error("Devin session is not open");
    return this.#bounded(
      this.#connection.setSessionConfigOption({ sessionId: this.sessionId, configId, value }),
    );
  }

  async prompt(text: string, callbacks: DevinCallbacks) {
    if (!this.#connection || this.#closed || this.#callbacks)
      throw new Error("Devin session is closed or busy");
    this.#callbacks = callbacks;
    try {
      // Native turns have no arbitrary wall-clock deadline; cancellation/close/process exit settle them.
      return await Promise.race([
        this.#connection.prompt({ sessionId: this.sessionId, prompt: [{ type: "text", text }] }),
        this.#failed,
      ]);
    } finally {
      this.#callbacks = undefined;
    }
  }

  async cancel() {
    if (this.#connection && !this.#closed)
      await this.#bounded(this.#connection.cancel({ sessionId: this.sessionId }));
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#fault = new Error("Devin session closed");
    this.#rejectFault(this.#fault);
    const child = this.#child;
    if (!child) return;
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 500);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else if (child.pid) {
        // Terminate only this owned CLI tree, including a native tool still running.
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            killer.kill();
            resolve();
          }, 2_000);
          const finish = () => {
            clearTimeout(timer);
            resolve();
          };
          killer.once("error", finish);
          killer.once("exit", finish);
        });
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    child.stdout.destroy();
    child.stderr.destroy();
    child.stdin.destroy();
  }
}
