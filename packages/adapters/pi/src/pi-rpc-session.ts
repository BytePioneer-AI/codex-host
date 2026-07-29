import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

export interface PiSessionState {
  sessionId: string;
  sessionFile: string | null;
  provider: string | null;
  modelId: string | null;
}

export interface PiTextTurnResult {
  text: string;
}

export type PiRpcFaultKind = "notInstalled" | "unavailable" | "protocolError" | "processExited";

export class PiRpcFaultError extends Error {
  constructor(
    readonly kind: PiRpcFaultKind,
    message: string,
  ) {
    super(message);
    this.name = "PiRpcFaultError";
  }
}

export interface PiRpcSessionOptions {
  cwd: string;
  command?: string;
  environment?: NodeJS.ProcessEnv;
  commandTimeoutMs?: number;
  turnTimeoutMs?: number;
  closeTimeoutMs?: number;
  onFault?: (error: PiRpcFaultError) => void;
}

interface PendingCommand {
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

interface ActiveTurn {
  text: string;
  onDelta(delta: string): void;
  resolve(value: PiTextTurnResult): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
  failure: Error | null;
}

const textDecoder = new TextDecoder("utf-8", { fatal: true });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function signalProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (!isRecord(error) || error.code !== "ESRCH") throw error;
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return Promise.race([
    new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

function spawnCommand(options: PiRpcSessionOptions): {
  command: string;
  arguments: string[];
  windowsVerbatimArguments: boolean;
} {
  const command = options.command ?? options.environment?.PI_COMMAND ?? "pi";
  const arguments_ = ["--mode", "rpc"];
  if (process.platform !== "win32" || !command.toLowerCase().endsWith(".cmd")) {
    return { command, arguments: arguments_, windowsVerbatimArguments: false };
  }
  const quote = (value: string): string => `"${value.replaceAll("%", "%%").replaceAll('"', '""')}"`;
  const commandLine = [command, ...arguments_].map(quote).join(" ");
  return {
    command: options.environment?.ComSpec ?? options.environment?.COMSPEC ?? "cmd.exe",
    arguments: ["/d", "/v:off", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}

export class PiRpcSession {
  readonly #options: Required<
    Pick<PiRpcSessionOptions, "commandTimeoutMs" | "turnTimeoutMs" | "closeTimeoutMs">
  > &
    PiRpcSessionOptions;
  #activeTurn: ActiveTurn | null = null;
  #buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  #child: ChildProcessWithoutNullStreams | null = null;
  #closed = false;
  #failed = false;
  #pending = new Map<string, PendingCommand>();
  #state: PiSessionState | null = null;

  constructor(options: PiRpcSessionOptions) {
    this.#options = {
      commandTimeoutMs: 30_000,
      turnTimeoutMs: 180_000,
      closeTimeoutMs: 2_000,
      ...options,
    };
  }

  get state(): PiSessionState {
    if (!this.#state) throw new Error("Pi RPC Session has not started");
    return this.#state;
  }

  async start(): Promise<this> {
    if (this.#child || this.#closed) throw new Error("Pi RPC Session cannot be started twice");
    const invocation = spawnCommand(this.#options);
    const environment = {
      ...process.env,
      ...this.#options.environment,
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
    };
    const child = spawn(invocation.command, invocation.arguments, {
      cwd: this.#options.cwd,
      env: environment,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    this.#child = child;
    child.stdout.on("data", (chunk: Buffer) => this.#push(chunk));
    child.stdout.on("end", () => {
      if (this.#buffer.length !== 0) {
        this.#fail(new PiRpcFaultError("protocolError", "Pi RPC stdout ended mid-frame"));
      }
    });
    child.stderr.resume();
    child.once("error", (error) => {
      const kind = isRecord(error) && error.code === "ENOENT" ? "notInstalled" : "unavailable";
      this.#fail(new PiRpcFaultError(kind, `Pi RPC failed to start: ${error.message}`));
    });
    child.once("exit", (code, signal) => {
      if (!this.#closed) {
        this.#fail(
          new PiRpcFaultError("processExited", `Pi RPC exited (code=${code}, signal=${signal})`),
        );
      }
    });
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      }),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("Pi RPC start timed out")),
          this.#options.commandTimeoutMs,
        ),
      ),
    ]);
    let state: Record<string, unknown>;
    try {
      state = await this.#send("get_state", {});
    } catch (error) {
      const fault =
        error instanceof PiRpcFaultError
          ? error
          : new PiRpcFaultError("unavailable", `Pi RPC state unavailable: ${message(error)}`);
      this.#fail(fault);
      throw fault;
    }
    const data = isRecord(state.data) ? state.data : null;
    this.#state = {
      sessionId: typeof data?.sessionId === "string" ? data.sessionId : randomUUID(),
      sessionFile: typeof data?.sessionFile === "string" ? data.sessionFile : null,
      provider:
        isRecord(data?.model) && typeof data.model.provider === "string"
          ? data.model.provider
          : null,
      modelId: isRecord(data?.model) && typeof data.model.id === "string" ? data.model.id : null,
    };
    return this;
  }

  async runTextTurn(text: string, onDelta: (delta: string) => void): Promise<PiTextTurnResult> {
    if (!this.#child || !this.#state || this.#closed || this.#failed)
      throw new Error("Pi RPC Session is unavailable");
    if (this.#activeTurn) throw new Error("Pi RPC Session already has an active Turn");
    if (text.length === 0) throw new Error("Pi text Turn must not be empty");

    const settled = new Promise<PiTextTurnResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#fail(new PiRpcFaultError("protocolError", "Pi text Turn timed out"));
      }, this.#options.turnTimeoutMs);
      this.#activeTurn = { text: "", onDelta, resolve, reject, timeout, failure: null };
    });
    try {
      await this.#send("prompt", { message: text });
    } catch (error) {
      this.#rejectActiveTurn(error instanceof Error ? error : new Error(message(error)));
    }
    return settled;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectAll(new Error("Pi RPC Session closed"));
    const child = this.#child;
    if (!child) return;
    if (child.stdin.writable) child.stdin.end();
    if (await waitForExit(child, this.#options.closeTimeoutMs)) return;
    signalProcessTree(child, "SIGTERM");
    if (await waitForExit(child, this.#options.closeTimeoutMs)) return;
    signalProcessTree(child, "SIGKILL");
    if (!(await waitForExit(child, this.#options.closeTimeoutMs))) {
      throw new Error("Pi RPC process tree did not exit within cleanup bounds");
    }
  }

  #push(chunk: Buffer<ArrayBufferLike>): void {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    let newline = this.#buffer.indexOf(0x0a);
    while (newline >= 0) {
      const frame = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      try {
        const value = JSON.parse(textDecoder.decode(frame));
        if (!isRecord(value) || typeof value.type !== "string") {
          throw new PiRpcFaultError("protocolError", "Pi RPC returned an invalid envelope");
        }
        this.#handle(value);
      } catch (error) {
        this.#fail(
          error instanceof PiRpcFaultError
            ? error
            : new PiRpcFaultError(
                "protocolError",
                `Pi RPC returned invalid JSONL: ${message(error)}`,
              ),
        );
      }
      newline = this.#buffer.indexOf(0x0a);
    }
  }

  #handle(value: Record<string, unknown>): void {
    if (value.type === "response") {
      const id = value.id;
      if (typeof id !== "string") {
        return this.#fail(new PiRpcFaultError("protocolError", "Pi RPC response has no id"));
      }
      const pending = this.#pending.get(id);
      if (!pending) {
        return this.#fail(
          new PiRpcFaultError("protocolError", "Pi RPC response id is not pending"),
        );
      }
      clearTimeout(pending.timeout);
      this.#pending.delete(id);
      if (value.success === true) pending.resolve(value);
      else
        pending.reject(
          new Error(typeof value.error === "string" ? value.error : "Pi RPC command failed"),
        );
      return;
    }
    const active = this.#activeTurn;
    if (!active) return;
    if (value.type === "message_update" && isRecord(value.assistantMessageEvent)) {
      const event = value.assistantMessageEvent;
      if (event.type === "text_delta" && typeof event.delta === "string") {
        active.text += event.delta;
        active.onDelta(event.delta);
      } else if (event.type === "error") {
        active.failure = new Error("Pi assistant message failed");
      }
      return;
    }
    if (value.type === "agent_settled") {
      clearTimeout(active.timeout);
      this.#activeTurn = null;
      if (active.failure) active.reject(active.failure);
      else active.resolve({ text: active.text });
    }
  }

  #send(type: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const child = this.#child;
    if (!child?.stdin.writable || this.#closed || this.#failed)
      return Promise.reject(new Error("Pi RPC stdin is unavailable"));
    const id = `codexhost-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Pi RPC '${type}' command timed out`));
      }, this.#options.commandTimeoutMs);
      this.#pending.set(id, { resolve, reject, timeout });
      const frame = Buffer.from(`${JSON.stringify({ id, type, ...payload })}\n`, "utf8");
      child.stdin.write(frame, (error) => {
        if (error) {
          clearTimeout(timeout);
          this.#pending.delete(id);
          reject(error);
        }
      });
    });
  }

  #rejectActiveTurn(error: Error): void {
    const active = this.#activeTurn;
    if (!active) return;
    clearTimeout(active.timeout);
    this.#activeTurn = null;
    active.reject(error);
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#rejectActiveTurn(error);
  }

  #fail(error: PiRpcFaultError): void {
    if (this.#closed || this.#failed) return;
    this.#failed = true;
    this.#rejectAll(error);
    this.#options.onFault?.(error);
  }
}
