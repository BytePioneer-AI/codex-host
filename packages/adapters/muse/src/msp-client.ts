import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { sanitizeDiagnosticTail, type HarnessError } from "@codexhost/harness-adapter";
import { commandInvocation } from "@codexhost/harness-discovery";

export type JsonObject = Record<string, unknown>;

export interface MuseRpcNotification {
  method: string;
  params?: JsonObject;
}

export interface MuseRpc {
  handshake(): Promise<JsonObject>;
  request(method: string, params?: JsonObject): Promise<JsonObject>;
  notify(method: string, params?: JsonObject): void;
  subscribe(handler: (notification: MuseRpcNotification) => void): () => void;
  /** Reports a terminal transport failure, including one preceding subscription. */
  subscribeFailure(handler: (error: MuseProcessError) => void): () => void;
  close(): Promise<void>;
}

export class MuseRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(message: string, code: number, data?: unknown) {
    super(message);
    this.name = "MuseRpcError";
    this.code = code;
    this.data = data;
  }
}

export class MuseProcessError extends Error {
  readonly harnessError: HarnessError;

  constructor(error: HarnessError) {
    super(error.message);
    this.name = "MuseProcessError";
    this.harnessError = error;
  }
}

interface PendingRequest {
  resolve(value: JsonObject): void;
  reject(error: unknown): void;
  timeout: NodeJS.Timeout;
}

type MuseRpcId = number | string;

function rpcId(value: unknown): MuseRpcId | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) return value;
  return undefined;
}

export interface MuseServeOptions {
  executable: string;
  cwd: string;
  environment: NodeJS.ProcessEnv;
  extraArguments?: string[];
  requestTimeoutMs?: number;
  closeTimeoutMs?: number;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class MuseServeClient implements MuseRpc {
  #child: ChildProcessWithoutNullStreams;
  #buffer = "";
  #nextId = 1;
  #pending = new Map<MuseRpcId, PendingRequest>();
  #listeners = new Set<(notification: MuseRpcNotification) => void>();
  #failureListeners = new Set<(error: MuseProcessError) => void>();
  #failure: MuseProcessError | null = null;
  #closed = false;
  #exited = false;
  #closePromise: Promise<void> | null = null;
  #stderr = "";
  #requestTimeoutMs: number;
  #closeTimeoutMs: number;

  constructor(options: MuseServeOptions) {
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.#closeTimeoutMs = options.closeTimeoutMs ?? 1_000;
    const invocation = commandInvocation(
      options.executable,
      ["serve", "--trust-workspace", ...(options.extraArguments ?? [])],
      options.environment,
    );
    this.#child = spawn(invocation.command, invocation.arguments, {
      cwd: options.cwd,
      env: options.environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    this.#child.stdout.setEncoding("utf8");
    this.#child.stderr.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => this.#onStdout(chunk));
    this.#child.stderr.on("data", (chunk: string) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-4000);
    });
    this.#child.on("error", (error) => this.#onProcessError("process", error));
    this.#child.stdin.on("error", (error) => this.#onProcessError("stdin", error));
    this.#child.stdout.on("error", (error) => this.#onProcessError("stdout", error));
    this.#child.stdout.on("end", () => {
      this.#onProcessError("stdout", new Error("output stream ended"));
    });
    this.#child.stderr.on("error", (error) => this.#onProcessError("stderr", error));
    this.#child.on("exit", (code, signal) => {
      this.#exited = true;
      if (this.#closed) return;
      const error = new MuseProcessError({
        code: "processExited",
        message: `Muse serve exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}`,
        retryable: true,
        ...(this.#stderr ? { diagnostic: sanitizeDiagnosticTail(this.#stderr) } : {}),
      });
      this.#failTransport(error);
    });
    this.#child.on("close", () => {
      this.#exited = true;
    });
  }

  async handshake(): Promise<JsonObject> {
    const result = await this.request("initialize", {
      clientInfo: { name: "codexhost", title: "Codex Host", version: "0.6.0" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized");
    return result;
  }

  async request(method: string, params?: JsonObject): Promise<JsonObject> {
    if (this.#failure) throw this.#failure;
    if (this.#closed) {
      throw new MuseProcessError({
        code: "invalidState",
        message: "Muse serve is closed",
        retryable: false,
      });
    }
    const id = this.#nextId;
    this.#nextId += 1;
    const payload: JsonObject = { jsonrpc: "2.0", id, method };
    if (params && Object.keys(params).length > 0) payload.params = params;
    const frame = `${JSON.stringify(payload)}\n`;
    const result = new Promise<JsonObject>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#failTransport(
          new MuseProcessError({
            code: "protocolError",
            message: `Muse RPC ${method} timed out after ${this.#requestTimeoutMs}ms`,
            retryable: true,
          }),
        );
      }, this.#requestTimeoutMs);
      this.#pending.set(id, { resolve, reject, timeout });
    });
    this.#write(frame);
    return result;
  }

  notify(method: string, params?: JsonObject): void {
    if (this.#closed || this.#failure) return;
    const payload: JsonObject = { jsonrpc: "2.0", method };
    if (params && Object.keys(params).length > 0) payload.params = params;
    this.#write(`${JSON.stringify(payload)}\n`);
  }

  subscribe(handler: (notification: MuseRpcNotification) => void): () => void {
    this.#listeners.add(handler);
    return () => this.#listeners.delete(handler);
  }

  subscribeFailure(handler: (error: MuseProcessError) => void): () => void {
    this.#failureListeners.add(handler);
    const failure = this.#failure;
    if (failure) {
      queueMicrotask(() => {
        if (this.#failureListeners.has(handler)) handler(failure);
      });
    }
    return () => this.#failureListeners.delete(handler);
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#failAll(
      new MuseProcessError({
        code: "invalidState",
        message: "Muse serve closed",
        retryable: false,
      }),
    );
    this.#closePromise = this.#stopProcess();
    return this.#closePromise;
  }

  async #stopProcess(): Promise<void> {
    if (this.#exited || !this.#child.pid) return;
    this.#child.stdin.end();
    this.#child.kill("SIGTERM");
    if (await this.#waitForExit()) return;
    this.#child.kill("SIGKILL");
    if (await this.#waitForExit()) return;
    throw new MuseProcessError({
      code: "processExited",
      message: "Muse serve did not exit after SIGKILL",
      retryable: true,
    });
  }

  #waitForExit(): Promise<boolean> {
    if (this.#exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      const finish = (exited: boolean): void => {
        clearTimeout(timeout);
        this.#child.off("exit", onExit);
        this.#child.off("close", onExit);
        resolve(exited);
      };
      const onExit = (): void => finish(true);
      const timeout = setTimeout(() => finish(false), this.#closeTimeoutMs);
      this.#child.once("exit", onExit);
      this.#child.once("close", onExit);
    });
  }

  #write(frame: string): void {
    try {
      this.#child.stdin.write(frame, (error) => {
        if (error) this.#onProcessError("stdin", error);
      });
    } catch (error) {
      this.#onProcessError("stdin", error);
    }
  }

  #onProcessError(source: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.#failTransport(
      new MuseProcessError({
        code: "processExited",
        message: `Muse serve ${source} failed: ${sanitizeDiagnosticTail(message)}`,
        retryable: true,
        ...(this.#stderr ? { diagnostic: sanitizeDiagnosticTail(this.#stderr) } : {}),
      }),
    );
  }

  #onStdout(chunk: string): void {
    if (this.#closed) return;
    this.#buffer += chunk;
    while (true) {
      const boundary = this.#buffer.indexOf("\n");
      if (boundary < 0) return;
      const line = this.#buffer.slice(0, boundary).trim();
      this.#buffer = this.#buffer.slice(boundary + 1);
      if (!line) continue;
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(frame) || frame.jsonrpc !== "2.0") continue;
      const id = rpcId(frame.id);
      const pending = id === undefined ? undefined : this.#pending.get(id);
      if (pending && id !== undefined && typeof frame.method !== "string") {
        this.#pending.delete(id);
        clearTimeout(pending.timeout);
        if (isRecord(frame.error)) {
          pending.reject(
            new MuseRpcError(
              typeof frame.error.message === "string" ? frame.error.message : "Muse RPC error",
              typeof frame.error.code === "number" ? frame.error.code : -32603,
              frame.error.data,
            ),
          );
          continue;
        }
        pending.resolve(isRecord(frame.result) ? frame.result : {});
        continue;
      }
      if (typeof frame.method === "string") {
        const notification = {
          method: frame.method,
          ...(isRecord(frame.params) ? { params: frame.params } : {}),
        };
        for (const listener of this.#listeners) listener(notification);
      }
    }
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #failTransport(error: MuseProcessError): void {
    if (this.#failure || this.#closed) return;
    this.#failure = error;
    this.#failAll(error);
    // Stop ambiguous native work after a lost acknowledgement. Explicit close callers
    // still receive any shutdown failure through the stored close promise.
    void this.close().catch(() => {});
    for (const listener of this.#failureListeners) listener(error);
  }
}
