import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { withNodeRuntimeOnPath } from "@codexhost/harness-discovery";
import { zcodeInvocation } from "./command.js";
import { ZcodeError, rpcError } from "./errors.js";
import { record, text } from "./protocol.js";

export interface TransportOptions {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  command?: string;
  timeoutMs?: number;
}
export interface RpcMessage {
  id?: string | number;
  method: string;
  params: unknown;
}
export class ZcodeTransport {
  #child: ChildProcessWithoutNullStreams | undefined;
  #nextId = 0;
  #pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  #closed = false;
  #fault: Error | undefined;
  #closePromise: Promise<void> | undefined;
  onMessage: ((message: RpcMessage) => void) | undefined;
  onFault: ((error: Error) => void) | undefined;
  constructor(readonly options: TransportOptions) {}
  start() {
    if (this.#child || this.#closed)
      throw new ZcodeError("invalidState", "ZCode transport is already started or closed");
    const environment = withNodeRuntimeOnPath(this.options.environment);
    const invocation = zcodeInvocation(environment, this.options.command);
    const child = spawn(invocation.command, invocation.arguments, {
      cwd: this.options.cwd,
      env: invocation.environment,
      stdio: "pipe",
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      ...(process.platform !== "win32" ? { detached: true } : {}),
    });
    this.#child = child;
    child.stderr.resume(); // Never forward native logs: provider configuration may contain credentials.
    child.on("error", () =>
      this.#fail(new ZcodeError("unavailable", "Could not start the ZCode app-server")),
    );
    child.on("exit", (code) => {
      if (!this.#closed)
        this.#fail(
          new ZcodeError("processExited", `ZCode app-server exited (${code ?? "signal"})`),
        );
    });
    child.stdin.on("error", () =>
      this.#fail(new ZcodeError("processExited", "ZCode input stream closed")),
    );
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      // Native history is delivered as one JSON record; bound it without truncating valid history.
      if (Buffer.byteLength(buffer) > 64 * 1024 * 1024)
        return this.#fail(new ZcodeError("protocolError", "ZCode response exceeds 64 MiB"));
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          this.#receive(JSON.parse(line));
        } catch {
          this.#fail(new ZcodeError("protocolError", "Invalid ZCode protocol message"));
        }
      }
    });
  }
  request(method: string, params: unknown): Promise<unknown> {
    if (this.#fault) return Promise.reject(this.#fault);
    if (this.#closed || !this.#child)
      return Promise.reject(new ZcodeError("invalidState", "ZCode transport is closed"));
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.#fail(
            new ZcodeError("unavailable", `ZCode ${method} timed out; delivery is unconfirmed`),
          ),
        this.options.timeoutMs ?? 30_000,
      );
      this.#pending.set(id, { resolve, reject, timer });
      this.#write({ id, method, params });
    });
  }
  respond(id: string | number, result: unknown) {
    this.#write({ id, result });
  }
  reject(id: string | number, message = "Unsupported ZCode client request") {
    this.#write({ id, error: { code: -32601, message } });
  }
  #write(value: unknown) {
    if (!this.#closed && !this.#fault) this.#child?.stdin.write(`${JSON.stringify(value)}\n`);
  }
  #receive(value: unknown) {
    const message = record(value);
    if (typeof message.method === "string") {
      const id =
        typeof message.id === "string" || typeof message.id === "number" ? message.id : undefined;
      if (this.onMessage)
        this.onMessage({
          method: message.method,
          params: message.params,
          ...(id !== undefined ? { id } : {}),
        });
      else if (id !== undefined) this.reject(id);
      return;
    }
    if (typeof message.id !== "number") throw new Error("Missing response ID");
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      const error = record(message.error);
      pending.reject(rpcError(Number(error.code), text(error.message)));
    } else if (Object.hasOwn(message, "result")) pending.resolve(message.result);
    else pending.reject(new ZcodeError("protocolError", "ZCode response has no result"));
  }
  #fail(error: Error) {
    if (this.#closed || this.#fault) return;
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
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ZcodeError("invalidState", "ZCode transport closed"));
    }
    this.#pending.clear();
    const child = this.#child;
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
    await wait(500);
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else if (child.pid) {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(() => {
            killer.kill();
            resolve();
          }, 2000);
          killer.once("error", finish);
          killer.once("exit", finish);
        });
        child.kill("SIGKILL");
      }
      await wait(2000);
    }
    child.stdout.destroy();
    child.stderr.destroy();
    child.stdin.destroy();
  }
}
