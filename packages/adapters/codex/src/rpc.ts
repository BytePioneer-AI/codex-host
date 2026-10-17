/** JSON-RPC client for one `codex app-server` (stdio) process. */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

export interface RpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

export class CodexRpcError extends Error {
  constructor(
    readonly method: string,
    readonly error: RpcErrorShape,
  ) {
    super(`${method}: ${error.message}`);
  }
}

type NotificationListener = (method: string, params: Record<string, unknown>) => void;
type ServerRequestListener = (
  id: number | string,
  method: string,
  params: Record<string, unknown>,
) => void;

export interface AppServerOptions {
  command?: string;
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
}

export class CodexAppServer {
  private readonly child: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { method: string; resolve(value: unknown): void; reject(error: Error): void }
  >();
  private readonly notificationListeners = new Set<NotificationListener>();
  private readonly requestListeners = new Set<ServerRequestListener>();
  private readonly exitListeners = new Set<(error: Error) => void>();
  private exited: Error | undefined;
  private stderrTail = "";

  constructor(options: AppServerOptions = {}) {
    this.child = spawn(options.command ?? "codex", ["app-server"], {
      cwd: options.cwd,
      env: options.environment ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    readline
      .createInterface({ input: this.child.stdout, crlfDelay: Infinity })
      .on("line", (line) => this.onLine(line));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-4000);
    });
    this.child.on("error", (error) => this.handleExit(error));
    this.child.on("exit", (code, signal) =>
      this.handleExit(
        new Error(
          `codex app-server exited (${signal ?? String(code)})${this.stderrTail === "" ? "" : `: ${this.stderrTail.trim().split("\n").at(-1) ?? ""}`}`,
        ),
      ),
    );
  }

  private handleExit(error: Error): void {
    if (this.exited !== undefined) return;
    this.exited = error;
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
    for (const listener of this.exitListeners) listener(error);
  }

  private onLine(line: string): void {
    let message: {
      id?: number | string;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
      error?: RpcErrorShape;
    };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }
    if (message.method !== undefined && message.id !== undefined) {
      for (const listener of this.requestListeners)
        listener(message.id, message.method, message.params ?? {});
      return;
    }
    if (message.method !== undefined) {
      for (const listener of this.notificationListeners)
        listener(message.method, message.params ?? {});
      return;
    }
    if (typeof message.id === "number") {
      const entry = this.pending.get(message.id);
      if (entry === undefined) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) entry.reject(new CodexRpcError(entry.method, message.error));
      else entry.resolve(message.result);
    }
  }

  private write(message: unknown): void {
    if (this.exited !== undefined) throw this.exited;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request<T>(method: string, params: unknown): Promise<T> {
    if (this.exited !== undefined) return Promise.reject(this.exited);
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.write(
      params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params },
    );
  }

  respond(id: number | string, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  respondError(id: number | string, code: number, message: string): void {
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  onNotification(listener: NotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onServerRequest(listener: ServerRequestListener): () => void {
    this.requestListeners.add(listener);
    return () => this.requestListeners.delete(listener);
  }

  onExit(listener: (error: Error) => void): () => void {
    if (this.exited !== undefined) listener(this.exited);
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  get closed(): boolean {
    return this.exited !== undefined;
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "codexhost-web", title: "CodexHost Web", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify("initialized");
  }

  close(): Promise<void> {
    if (this.exited !== undefined) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill("SIGKILL");
        resolve();
      }, 3000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      this.child.stdin.end();
      this.child.kill("SIGTERM");
    });
  }
}
