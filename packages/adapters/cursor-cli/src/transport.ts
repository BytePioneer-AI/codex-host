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
  type AvailableCommand,
  type SessionConfigOption,
} from "@agentclientprotocol/sdk";
import { createCursorDelegationBridge } from "./delegation-bridge.js";
import { cursorInvocation } from "./command.js";
import { parseCursorNativeModels } from "./models.js";

export interface CursorTransportOptions {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  command?: string;
  timeoutMs?: number;
  delegation?: boolean;
  /** History replay needs session/load, not the account model catalog. */
  loadModelCatalog?: boolean;
}
export type CursorSessionInfo = (NewSessionResponse | LoadSessionResponse) & {
  nativeModels?: CursorNativeModel[];
};
export interface CursorNativeModel {
  value: string;
  name: string;
  configOptions: SessionConfigOption[];
}
export interface CursorCallbacks {
  update(value: SessionNotification): void;
  permission(value: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  extension(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  notification?(method: string, params: Record<string, unknown>): void;
}
export class CursorTransport {
  sessionId = "";
  replay: SessionNotification[] = [];
  availableCommands: AvailableCommand[] = [];
  #child: ChildProcessWithoutNullStreams | undefined;
  #connection: ClientSideConnection | undefined;
  #callbacks: CursorCallbacks | undefined;
  #closed = false;
  #closing: Promise<void> | undefined;
  #opened = false;
  #preparation: Promise<void> | undefined;
  #canLoad = false;
  #delegation: Awaited<ReturnType<typeof createCursorDelegationBridge>>;
  #fault: Error | undefined;
  #rejectFault!: (error: Error) => void;
  readonly #failed = new Promise<never>((_, reject) => {
    this.#rejectFault = reject;
  });

  constructor(
    readonly options: CursorTransportOptions,
    readonly cachedModels?: CursorNativeModel[],
  ) {
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
            reject(new Error("Cursor ACP request timed out"));
            void this.close();
          }, timeout);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Start/authenticate the owned process without touching any native session. */
  prepare(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("Cursor session closed"));
    return (this.#preparation ??= this.#prepare());
  }

  async #prepare(): Promise<void> {
    const invocation = cursorInvocation(this.options.environment, this.options.command);
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
    child.on("error", () => fault("Cursor ACP process could not start"));
    child.on("exit", (code) => fault(`Cursor ACP process exited (${code ?? "signal"})`));
    child.stderr.resume(); // Native diagnostics may contain secrets; never copy them to Host events.
    this.#connection = new ClientSideConnection(
      () => ({
        sessionUpdate: (value) => {
          if (this.sessionId && value.sessionId !== this.sessionId) return;
          if (value.update.sessionUpdate === "available_commands_update") {
            this.availableCommands = value.update.availableCommands;
            return;
          }
          if (this.#callbacks) this.#callbacks.update(value);
          else if (this.replay.length < 100_000) this.replay.push(value);
          else throw new Error("Cursor replay exceeds the supported history limit");
        },
        requestPermission: (value) =>
          this.#callbacks && value.sessionId === this.sessionId
            ? this.#callbacks.permission(value)
            : Promise.resolve({ outcome: { outcome: "cancelled" } }),
        extMethod: (method, params) =>
          this.#callbacks
            ? this.#callbacks.extension(method, params)
            : Promise.resolve({ outcome: { outcome: "cancelled" } }),
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
          clientCapabilities: { _meta: { parameterizedModelPicker: true } },
          clientInfo: { name: "codexhost", version: "0.6.2" },
        }),
      );
      if (init.protocolVersion !== 1)
        throw new Error("Cursor does not support the required ACP session protocol");
      this.#canLoad = init.agentCapabilities?.loadSession === true;
      // This reuses an existing native login. The adapter never launches login or reads credentials.
      await this.#bounded(this.#connection.authenticate({ methodId: "cursor_login" }));
      if (this.#closed) throw new Error("Cursor session closed");
      if (this.options.delegation && init.agentCapabilities?.mcpCapabilities?.http)
        this.#delegation = await createCursorDelegationBridge(
          this.options.cwd,
          this.options.environment,
        );
      if (this.#closed) {
        await this.#delegation?.close();
        throw new Error("Cursor session closed");
      }
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async open(sessionId?: string): Promise<CursorSessionInfo> {
    if (this.#closed || this.#opened) throw new Error("Cursor transport cannot be reopened");
    this.#opened = true;
    try {
      await this.prepare();
      if (!this.#connection || this.#closed) throw new Error("Cursor session closed");
      if (sessionId && !this.#canLoad)
        throw new Error("Cursor does not support the required ACP session protocol");
      const mcpServers = this.#delegation ? [this.#delegation.descriptor] : [];
      this.sessionId = sessionId ?? "";
      const info = sessionId
        ? await this.#bounded(
            this.#connection.loadSession({ sessionId, cwd: this.options.cwd, mcpServers }),
          )
        : await this.#bounded(this.#connection.newSession({ cwd: this.options.cwd, mcpServers }));
      if ("sessionId" in info && typeof info.sessionId === "string")
        this.sessionId = info.sessionId;
      if (!this.sessionId) throw new Error("Cursor returned no native session ID");
      if (this.options.loadModelCatalog === false) return info;
      // The live load response remains authoritative for selection and available models.
      // Only reuse the source's full parameter catalog when its model list still matches.
      const modelOption = info.configOptions?.find((option) => option.id === "model");
      const available =
        modelOption?.type === "select"
          ? modelOption.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options))
          : undefined;
      if (
        this.cachedModels?.length &&
        available?.length === this.cachedModels.length &&
        available.every((model) =>
          this.cachedModels?.some(
            (cached) => cached.value === model.value && cached.name === model.name,
          ),
        )
      )
        return { ...info, nativeModels: structuredClone(this.cachedModels) };
      try {
        const models = await this.#bounded(
          this.#connection.extMethod("cursor/list_available_models", {}),
        );
        return { ...info, nativeModels: parseCursorNativeModels(models) };
      } catch (error) {
        // Older Cursor releases may only expose the standard ACP configuration.
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== -32601
        )
          throw error;
        return info;
      }
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async configure(configId: string, value: string) {
    if (!this.#connection) throw new Error("Cursor session is not open");
    return this.#bounded(
      this.#connection.setSessionConfigOption({ sessionId: this.sessionId, configId, value }),
    );
  }

  async prompt(text: string, callbacks: CursorCallbacks) {
    if (!this.#connection || this.#closed || this.#callbacks)
      throw new Error("Cursor session is closed or busy");
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

  close(): Promise<void> {
    return (this.#closing ??= this.#close());
  }

  async #close() {
    this.#closed = true;
    this.#fault = new Error("Cursor session closed");
    this.#rejectFault(this.#fault);
    await this.#delegation?.close();
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
