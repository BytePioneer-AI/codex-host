import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { commandInvocation } from "@codexhost/harness-discovery";
import { record, text, TraeError } from "./protocol.js";

export interface TraeOptions {
  command?: string;
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}
export type NativeHandler = (
  method: string,
  params: Record<string, unknown>,
  id?: string | number,
) => void;

/** Trae's own app-server protocol; never route these frames to the official Codex connection. */
export class TraeTransport {
  onMessage: NativeHandler = () => {};
  onFault: (error: TraeError) => void = () => {};
  #child: ChildProcessWithoutNullStreams;
  #pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >();
  #id = 0;
  #closed = false;
  #fault: TraeError | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(
    command: string,
    cwd: string,
    environment: NodeJS.ProcessEnv,
    readonly timeoutMs = 30_000,
  ) {
    const invocation = commandInvocation(command, ["app-server", "--stdio"], environment);
    this.#child = spawn(invocation.command, invocation.arguments, {
      cwd,
      env: environment,
      windowsHide: true,
      stdio: "pipe",
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      detached: process.platform !== "win32",
    });
    this.#child.stderr.resume();
    this.#child.on("error", () =>
      this.#fail(new TraeError("processExited", "Could not start Trae CLI")),
    );
    this.#child.stdin.on("error", () =>
      this.#fail(new TraeError("processExited", "Trae input closed")),
    );
    this.#child.on("exit", () => this.#fail(new TraeError("processExited", "Trae CLI exited")));
    let parts: Buffer[] = [];
    let size = 0;
    this.#child.stdout.on("data", (chunk: Buffer) => {
      if (this.#closed || this.#fault) return;
      let start = 0;
      while (start < chunk.length) {
        const end = chunk.indexOf(10, start);
        const part = chunk.subarray(start, end < 0 ? chunk.length : end);
        size += part.length;
        if (size > 32 * 1024 * 1024) {
          this.#fail(new TraeError("protocolError", "Trae frame exceeded 32 MiB"));
          return;
        }
        parts.push(part);
        if (end < 0) break;
        const line = Buffer.concat(parts, size).toString("utf8");
        parts = [];
        size = 0;
        start = end + 1;
        if (!line.trim()) continue;
        try {
          this.#receive(record(JSON.parse(line)));
        } catch {
          this.#fail(new TraeError("protocolError", "Invalid Trae protocol frame"));
          return;
        }
      }
    });
  }

  async initialize(): Promise<void> {
    const initialized = record(
      await this.call("initialize", {
        clientInfo: { name: "codexhost", title: "CodexHost Trae", version: "0.0.0" },
        capabilities: { experimentalApi: true },
      }),
    );
    if (!text(initialized.userAgent))
      throw new TraeError("protocolError", "Trae app-server handshake is incompatible");
    this.#write({ method: "initialized", params: {} });
  }

  call(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.#closed || this.#fault)
      return Promise.reject(
        this.#fault ?? new TraeError("invalidState", "Trae transport is closed"),
      );
    return new Promise((resolve, reject) => {
      const id = ++this.#id;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        const error = new TraeError(
          "protocolError",
          `Trae ${method} timed out; outcome is unknown`,
        );
        reject(error);
        this.#fail(error);
      }, this.timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#write({ id, method, params });
    });
  }

  respond(id: string | number, result: unknown): void {
    this.#write({ id, result });
  }
  reject(id: string | number): void {
    this.#write({ id, error: { code: -32601, message: "Unsupported Trae client request" } });
  }

  #write(frame: unknown): void {
    if (!this.#closed && !this.#fault) this.#child.stdin.write(JSON.stringify(frame) + "\n");
  }
  #receive(frame: Record<string, unknown>): void {
    if (typeof frame.method === "string") {
      const id =
        typeof frame.id === "string" || typeof frame.id === "number" ? frame.id : undefined;
      this.onMessage(frame.method, record(frame.params), id);
      return;
    }
    const pending = typeof frame.id === "number" ? this.#pending.get(frame.id) : undefined;
    if (!pending) return;
    this.#pending.delete(frame.id as number);
    clearTimeout(pending.timer);
    if (frame.error) {
      const error = record(frame.error);
      if (typeof error.code !== "number") {
        const invalid = new TraeError("protocolError", "Invalid Trae RPC error code");
        pending.reject(invalid);
        this.#fail(invalid);
        return;
      }
      const message = text(error.message);
      // Classify internally; never publish native text that could echo prompts or credentials.
      const code =
        /auth|log.?in|unauthorized/i.test(message) || error.code === 401
          ? "authenticationRequired"
          : /(?:thread|session).*(?:not found|does not exist)|(?:no|missing|unknown).*(?:thread|session)|not found.*(?:thread|session)/i.test(
                message,
              )
            ? "sessionNotFound"
            : error.code === -32601
              ? "unsupported"
              : error.code === -32602
                ? "invalidRequest"
                : "nativeFailure";
      pending.reject(new TraeError(code, `Trae rejected the operation (${String(error.code)})`));
    } else if (Object.hasOwn(frame, "result")) pending.resolve(frame.result);
    else {
      const error = new TraeError("protocolError", "Trae response omitted result");
      pending.reject(error);
      this.#fail(error);
    }
  }
  #fail(error: TraeError): void {
    if (this.#closed || this.#fault) return;
    this.#fault = error;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.onFault(error);
    void this.close();
  }
  close(): Promise<void> {
    return (this.#closePromise ??= this.#close());
  }
  async #close(): Promise<void> {
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new TraeError("invalidState", "Trae transport closed"));
    }
    this.#pending.clear();
    const child = this.#child;
    child.stdin.destroy();
    if (child.exitCode !== null || child.signalCode !== null) {
      child.stdout.destroy();
      child.stderr.destroy();
      return;
    }
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    if (process.platform === "win32" && child.pid) {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.on("error", () => child.kill());
    } else if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill();
      }
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      exited,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          if (child.pid && process.platform !== "win32") {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              /* already gone */
            }
          }
          child.kill("SIGKILL");
          resolve();
        }, 3000);
      }),
    ]);
    clearTimeout(timer);
    child.stdout.destroy();
    child.stderr.destroy();
  }
}
