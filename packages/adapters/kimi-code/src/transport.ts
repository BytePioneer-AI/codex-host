import { spawn, execFile, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { z } from "zod";
import { commandInvocation, resolveHarnessExecutable } from "@codexhost/harness-discovery";
import {
  KimiError,
  SERVER_VERSION,
  frameEnvelopeSchema,
  parse,
  type KimiTransport,
  type NativeEvent,
  type TransportOptions,
} from "./protocol.js";

const envelopeSchema = z.object({ code: z.number(), data: z.unknown() });
function businessError(code: number): KimiError {
  const kind =
    code === 40401
      ? "sessionNotFound"
      : Math.floor(code / 100) === 401
        ? "authenticationRequired"
        : Math.floor(code / 100) === 409
          ? "sessionBusy"
          : Math.floor(code / 100) === 400
            ? "invalidRequest"
            : "nativeFailure";
  // Native msg/details may include provider credentials, tool arguments, or user answers.
  return new KimiError(
    kind,
    `Kimi Code rejected the operation (code ${code})`,
    kind === "sessionBusy",
  );
}
function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}
async function terminate(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform === "win32") {
    if (!exited(child))
      await new Promise<void>((resolve) => {
        execFile(
          "taskkill.exe",
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true, timeout: 5_000 },
          () => resolve(),
        );
      });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* The owned group may already be gone. */
    }
  }
  for (let attempt = 0; attempt < 30 && !exited(child); attempt++) await delay(100);
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* Also remove surviving tool children. */
    }
  }
  if (!exited(child)) {
    child.kill("SIGKILL");
    for (let attempt = 0; attempt < 20 && !exited(child); attempt++) await delay(100);
  }
  if (!exited(child))
    throw new KimiError("processExited", "Kimi Code owned process did not terminate");
}

class ManagedTransport implements KimiTransport {
  #socket: WebSocket | undefined;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #abort = new AbortController();
  #fault: ((error: KimiError) => void) | undefined;
  #pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: KimiError) => void; timer: NodeJS.Timeout }
  >();
  #reconnectTimer: NodeJS.Timeout | undefined;
  #reconnects = 0;

  constructor(
    private child: ChildProcess,
    private url: string,
    private token: string,
  ) {
    child.once("exit", () => {
      if (!this.#closed) this.#fault?.(new KimiError("processExited", "Kimi Code process exited"));
    });
  }
  setEndpoint(url: string, token: string): void {
    this.url = url;
    this.token = token;
  }
  async request(route: string, method: "GET" | "POST" = "GET", body?: unknown): Promise<unknown> {
    if (this.#closed) throw new KimiError("invalidState", "Kimi Code transport is closed");
    let response: Response;
    try {
      response = await fetch(this.url + route, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        signal: AbortSignal.any([this.#abort.signal, AbortSignal.timeout(15_000)]),
      });
    } catch {
      throw new KimiError("unavailable", "Kimi Code request failed or timed out", true);
    }
    if (response.status === 401) throw businessError(40101);
    if (!response.ok)
      throw new KimiError("nativeFailure", `Kimi Code HTTP request failed (${response.status})`);
    const text = await response.text();
    if (text.length > 32 * 1024 * 1024)
      throw new KimiError("protocolError", "Kimi Code response exceeds 32 MiB");
    const envelope = parse(envelopeSchema, JSON.parse(text));
    if (envelope.code !== 0) throw businessError(envelope.code);
    return envelope.data;
  }
  async connect(
    onEvent: (event: NativeEvent) => void,
    onFault: (error: KimiError) => void,
  ): Promise<void> {
    if (this.#closed || exited(this.child))
      throw new KimiError("processExited", "Kimi Code process is unavailable");
    this.#fault = onFault;
    const socket = new WebSocket(this.url.replace(/^http/u, "ws") + "/api/v1/ws", {
      headers: { Authorization: `Bearer ${this.token}` },
      handshakeTimeout: 10_000,
      maxPayload: 32 * 1024 * 1024,
    });
    this.#socket = socket;
    socket.on("message", (raw) => {
      try {
        const value: unknown = JSON.parse(raw.toString());
        const ack = z
          .object({
            type: z.literal("ack"),
            id: z.string(),
            code: z.number(),
            payload: z.unknown(),
          })
          .safeParse(value);
        if (ack.success) {
          const pending = this.#pending.get(ack.data.id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.#pending.delete(ack.data.id);
          if (ack.data.code === 0) pending.resolve(ack.data.payload);
          else pending.reject(businessError(ack.data.code));
          return;
        }
        const event = parse(frameEnvelopeSchema, value);
        if (event.type === "ping") {
          socket.send(JSON.stringify({ type: "pong", payload: event.payload }));
          return;
        }
        if (event.type === "server_hello") {
          if (event.payload?.protocol_version !== 2)
            throw new KimiError("unsupported", "Kimi Code WebSocket protocol is not version 2");
          return;
        }
        if (event.type === "error" && event.payload?.fatal === true)
          throw new KimiError("protocolError", "Kimi Code WebSocket reported a fatal error");
        onEvent(event);
      } catch (error) {
        onFault(
          error instanceof KimiError
            ? error
            : new KimiError("protocolError", "Kimi Code WebSocket returned an invalid frame"),
        );
      }
    });
    socket.on("error", () => {
      /* open rejects; an established socket reconnects on close. */
    });
    socket.once("close", () => {
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new KimiError("unavailable", "Kimi Code WebSocket disconnected", true));
      }
      this.#pending.clear();
      if (this.#closed) return;
      if (++this.#reconnects > 2 || exited(this.child)) {
        onFault(new KimiError("unavailable", "Kimi Code WebSocket recovery failed"));
        return;
      }
      this.#reconnectTimer = setTimeout(() => {
        void this.connect(onEvent, onFault).then(
          () => onEvent({ type: "transport.reconnected" }),
          () => onFault(new KimiError("unavailable", "Kimi Code WebSocket recovery failed")),
        );
      }, 200);
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", () =>
        reject(new KimiError("unavailable", "Cannot connect to Kimi Code WebSocket")),
      );
      socket.once("close", () =>
        reject(new KimiError("unavailable", "Kimi Code WebSocket closed during connection")),
      );
    });
  }
  async subscribe(sessionId: string, cursor: { seq: number; epoch: string }): Promise<void> {
    const socket = this.#socket;
    if (this.#closed || socket?.readyState !== WebSocket.OPEN)
      throw new KimiError("unavailable", "Kimi Code WebSocket is not connected");
    const id = randomUUID();
    const result = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new KimiError("unavailable", "Kimi Code subscription timed out"));
      }, 10_000);
      this.#pending.set(id, { resolve, reject, timer });
      socket.send(
        JSON.stringify({
          type: "subscribe",
          id,
          payload: { session_ids: [sessionId], cursors: { [sessionId]: cursor } },
        }),
      );
    });
    const ack = parse(
      z.object({
        accepted: z.array(z.string()),
        not_found: z.array(z.string()),
        resync_required: z.array(z.string()),
      }),
      result,
    );
    if (!ack.accepted.includes(sessionId) || ack.not_found.includes(sessionId))
      throw new KimiError("sessionNotFound", "Kimi Code did not accept the session subscription");
    if (ack.resync_required.includes(sessionId))
      throw new KimiError("protocolError", "Kimi Code rejected a freshly read snapshot cursor");
  }
  close(): Promise<void> {
    if (!this.#closePromise) {
      this.#closePromise = this.#close().catch((error: unknown) => {
        this.#closePromise = undefined;
        throw error;
      });
    }
    return this.#closePromise;
  }
  async #close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#reconnectTimer);
    this.#abort.abort();
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new KimiError("invalidState", "Kimi Code transport closed"));
    }
    this.#pending.clear();
    this.#socket?.terminate();
    await terminate(this.child);
    this.token = "";
  }
}

export async function startKimiTransport(options: TransportOptions): Promise<KimiTransport> {
  const resolution = resolveHarnessExecutable(
    {
      id: "kimi-code",
      command: "kimi",
      commandEnvironmentVariable: "CODEXHOST_KIMI_COMMAND",
      installRoots: {
        windows: ["~/.kimi-code/bin"],
        posix: ["~/.kimi-code/bin", "~/.local/bin", "/usr/local/bin"],
      },
    },
    { environment: options.environment, ...(options.command ? { command: options.command } : {}) },
  );
  if (!resolution) throw new KimiError("notInstalled", "Kimi Code executable was not found");
  const invocation = commandInvocation(
    resolution.executable,
    ["web", "--no-open", "--host", "127.0.0.1", "--port", "0"],
    options.environment,
  );
  const child = spawn(invocation.command, invocation.arguments, {
    cwd: options.cwd,
    env: options.environment,
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buffer = "",
    spawnFailed = false;
  child.once("error", () => {
    spawnFailed = true;
  });
  // The native banner contains the bearer token. Keep it private and bounded, never in diagnostics.
  const collect = (chunk: Buffer) => {
    buffer = (buffer + chunk.toString()).slice(-16_384);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  const transport = new ManagedTransport(child, "", "");
  options.onCreated?.(transport);
  try {
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      if (spawnFailed || exited(child))
        throw new KimiError("processExited", "Kimi Code service failed to start");
      const match = /http:\/\/127\.0\.0\.1:([1-9]\d*)/u.exec(buffer);
      if (match) {
        const home = options.environment.KIMI_CODE_HOME || path.join(homedir(), ".kimi-code");
        const token = (
          await readFile(path.resolve(options.cwd, home, "server.token"), "utf8")
        ).trim();
        if (!token || /[\r\n]/u.test(token))
          throw new KimiError("authenticationRequired", "Kimi Code server token is invalid");
        buffer = "";
        child.stdout?.off("data", collect);
        child.stderr?.off("data", collect);
        child.stdout?.resume();
        child.stderr?.resume();
        transport.setEndpoint(`http://127.0.0.1:${match[1]}`, token);
        const meta = parse(
          z.object({ server_version: z.string() }),
          await transport.request("/api/v1/meta"),
        );
        if (meta.server_version !== SERVER_VERSION)
          throw new KimiError("unsupported", `This plugin requires Kimi Code ${SERVER_VERSION}`);
        return transport;
      }
      await delay(50);
    }
    throw new KimiError("unavailable", "Kimi Code service startup timed out", true);
  } catch (error) {
    await transport.close();
    throw error;
  }
}
