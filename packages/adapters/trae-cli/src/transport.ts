import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  type InitializeResponse,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
} from "@agentclientprotocol/sdk";
import { traeInvocation } from "./command.js";
import { TraeCliError } from "./common.js";
import type { SessionInfo } from "./configuration.js";

export interface TraeOptions {
  environment?: NodeJS.ProcessEnv;
  command?: string;
  timeoutMs?: number;
}
export interface Callbacks {
  update(value: SessionNotification): void;
  permission(value: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  question(value: CreateElicitationRequest): Promise<CreateElicitationResponse>;
}
export class TraeTransport {
  #child: ChildProcessWithoutNullStreams | undefined;
  #connection: ClientSideConnection | undefined;
  #closed = false;
  #closing: Promise<void> | undefined;
  #fault: Error | undefined;
  #rejectFault!: (error: Error) => void;
  #failed = new Promise<never>((_, reject) => {
    this.#rejectFault = reject;
  });
  #collecting = false;
  #replay: SessionNotification[] = [];
  #overflow = false;
  #callbacks: Callbacks | undefined;
  sessionId = "";
  initialize: InitializeResponse | undefined;
  onConfiguration: ((info: Partial<SessionInfo>) => void) | undefined;
  onFault: ((error: Error) => void) | undefined;
  constructor(
    readonly cwd: string,
    readonly options: TraeOptions = {},
  ) {
    void this.#failed.catch(() => {});
  }
  get closed() {
    return this.#closed || this.#fault !== undefined;
  }
  #connected() {
    if (!this.#connection || this.closed)
      throw this.#fault ?? new TraeCliError("invalidState", "TRAE CLI connection is closed");
    return this.#connection;
  }
  #fail(error: Error) {
    if (this.#fault) return;
    this.#fault = error;
    this.#rejectFault(error);
    this.onFault?.(error);
  }
  async bounded<T>(work: Promise<T>): Promise<T> {
    if (this.closed)
      throw this.#fault ?? new TraeCliError("invalidState", "TRAE CLI connection is closed");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        this.#failed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const error = new TraeCliError(
              "processExited",
              "TRAE CLI request timed out; connection retired",
            );
            this.#fail(error);
            void this.close();
            reject(error);
          }, this.options.timeoutMs ?? 30_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async connect() {
    if (this.#connection || this.#closed)
      throw new TraeCliError("invalidState", "TRAE CLI transport cannot reopen");
    const environment = this.options.environment ?? process.env;
    const invocation = traeInvocation(environment, this.options.command);
    const child = spawn(invocation.command, invocation.arguments, {
      cwd: this.cwd,
      env: environment,
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      stdio: "pipe",
      ...(process.platform === "win32" ? {} : { detached: true }),
    });
    this.#child = child;
    child.on("error", () =>
      this.#fail(new TraeCliError("processExited", "TRAE CLI ACP process could not start")),
    );
    child.on("exit", () => {
      if (!this.#closed)
        this.#fail(new TraeCliError("processExited", "TRAE CLI ACP process exited"));
    });
    child.stderr.resume(); // Credentials and server diagnostics never become Host events.
    this.#connection = new ClientSideConnection(
      () => ({
        sessionUpdate: (value) => {
          if (this.sessionId && value.sessionId !== this.sessionId) return;
          if (this.#collecting) {
            if (this.#replay.length < 50_000) this.#replay.push(value);
            else this.#overflow = true;
            return;
          }
          if (value.update.sessionUpdate === "config_option_update")
            this.onConfiguration?.({ configOptions: value.update.configOptions });
          if (value.update.sessionUpdate === "current_mode_update")
            this.onConfiguration?.({ _meta: { currentModeId: value.update.currentModeId } });
          this.#callbacks?.update(value);
        },
        requestPermission: (value) =>
          this.#callbacks && "sessionId" in value && value.sessionId === this.sessionId
            ? this.#callbacks.permission(value)
            : Promise.resolve({ outcome: { outcome: "cancelled" } }),
        unstable_createElicitation: (value) =>
          this.#callbacks && "sessionId" in value && value.sessionId === this.sessionId
            ? this.#callbacks.question(value)
            : Promise.resolve({ action: "cancel" }),
      }),
      ndJsonStream(
        Writable.toWeb(child.stdin),
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      ),
    );
    const init = await this.bounded(
      this.#connection.initialize({
        protocolVersion: 1,
        clientInfo: { name: "codexhost", version: "0.20.0" },
        clientCapabilities: { elicitation: { form: {} } },
      }),
    );
    if (init.protocolVersion !== 1)
      throw new TraeCliError("unsupported", "TRAE CLI ACP protocol version is unsupported");
    this.initialize = init;
  }
  async listSessions() {
    if (!this.#connection) throw new TraeCliError("invalidState", "TRAE CLI is not connected");
    return this.bounded(this.#connection.listSessions({ cwd: this.cwd }));
  }
  async verifyWorkspace(sessionId: string) {
    let cursor: string | undefined;
    const seen = new Set<string>();
    let found = 0;
    do {
      const page = await this.bounded(
        this.#connected().listSessions({ cwd: this.cwd, ...(cursor ? { cursor } : {}) }),
      );
      for (const row of page.sessions)
        if (row.sessionId === sessionId) {
          if (row.cwd !== this.cwd)
            throw new TraeCliError("invalidRequest", "TRAE CLI Session workspace does not match");
          found++;
        }
      cursor = page.nextCursor ?? undefined;
      if (cursor && seen.has(cursor))
        throw new TraeCliError("protocolError", "TRAE CLI history pagination repeats");
      if (cursor) seen.add(cursor);
    } while (cursor);
    if (found !== 1)
      throw new TraeCliError(
        "sessionNotFound",
        "TRAE CLI Session was not found uniquely in this workspace",
      );
  }
  async open(sessionId?: string): Promise<{ info: SessionInfo; replay: SessionNotification[] }> {
    if (!this.#connection) throw new TraeCliError("invalidState", "TRAE CLI is not connected");
    if (sessionId) {
      if (!this.initialize?.agentCapabilities?.loadSession)
        throw new TraeCliError("unsupported", "TRAE CLI does not advertise session/load");
      await this.verifyWorkspace(sessionId);
    }
    this.sessionId = sessionId ?? "";
    this.#replay = [];
    this.#overflow = false;
    this.#collecting = true;
    try {
      const info = await this.bounded(
        sessionId
          ? this.#connection.loadSession({ sessionId, cwd: this.cwd, mcpServers: [] })
          : this.#connection.newSession({ cwd: this.cwd, mcpServers: [] }),
      );
      if ("sessionId" in info) {
        if (
          typeof info.sessionId !== "string" ||
          !info.sessionId ||
          (sessionId && sessionId !== info.sessionId)
        )
          throw new TraeCliError(
            "protocolError",
            "TRAE CLI returned a different or invalid Session ID",
          );
        this.sessionId = info.sessionId;
      }
      if (
        !this.sessionId ||
        this.#overflow ||
        this.#replay.some((event) => event.sessionId !== this.sessionId)
      )
        throw new TraeCliError(
          "protocolError",
          "TRAE CLI Session replay is incomplete or mismatched",
        );
      return { info, replay: this.#replay };
    } finally {
      this.#collecting = false;
    }
  }
  async reload() {
    return this.open(this.sessionId);
  }
  async configure(configId: string, value: string) {
    return this.bounded(
      this.#connected().setSessionConfigOption({ sessionId: this.sessionId, configId, value }),
    );
  }
  async mode(modeId: string) {
    return this.bounded(this.#connected().setSessionMode({ sessionId: this.sessionId, modeId }));
  }
  async prompt(text: string, callbacks: Callbacks) {
    if (this.closed || !this.sessionId || this.#callbacks)
      throw new TraeCliError("invalidState", "TRAE CLI is closed or busy");
    this.#callbacks = callbacks;
    try {
      return await Promise.race([
        this.#connected().prompt({ sessionId: this.sessionId, prompt: [{ type: "text", text }] }),
        this.#failed,
      ]);
    } finally {
      this.#callbacks = undefined;
    }
  }
  async cancel() {
    if (!this.closed && this.sessionId)
      await this.bounded(this.#connected().cancel({ sessionId: this.sessionId }));
  }
  close() {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#rejectFault(new TraeCliError("invalidState", "TRAE CLI connection closed"));
    return (this.#closing = this.#closeResources());
  }
  async #closeResources() {
    const child = this.#child;
    if (!child) return;
    child.stdin.end();
    const wait = async (ms: number) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          child.off("exit", done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        child.once("exit", done);
      });
    };
    await wait(500);
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      if (process.platform === "win32") {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            killer.kill();
            resolve();
          }, 2_000);
          const done = () => {
            clearTimeout(timer);
            resolve();
          };
          killer.once("error", done);
          killer.once("exit", done);
        });
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await wait(2_000);
    }
    child.stdout.destroy();
    child.stderr.destroy();
    child.stdin.destroy();
  }
}
