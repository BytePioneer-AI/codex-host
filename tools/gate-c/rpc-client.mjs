import { spawn, spawnSync } from "node:child_process";

import { buildPiInvocation, prepareSpawn } from "./command.mjs";
import { asGateCError, GateCError } from "./errors.mjs";
import { serializeJsonLine, StrictJsonlDecoder } from "./jsonl.mjs";

const DEFAULTS = {
  commandTimeoutMs: 30_000,
  pendingCloseMs: 1_000,
  closeGraceMs: 2_000,
  forceGraceMs: 2_000,
  protocolEofGraceMs: 25,
  stderrLimitBytes: 16 * 1024,
  maxFrameBytes: 16 * 1024 * 1024,
};

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function boundedAppend(current, chunk, limit) {
  const next = Buffer.concat([current, Buffer.from(chunk)]);
  return next.length <= limit ? next : next.subarray(next.length - limit);
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    delay(timeoutMs).then(() => false),
  ]);
}

function unixProcessGroupExists(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function waitForProcessTreeExit(child, timeoutMs) {
  if (process.platform === "win32" || !child.pid) return waitForExit(child, timeoutMs);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const parentExited = child.exitCode !== null || child.signalCode !== null;
    if (parentExited && !unixProcessGroupExists(child.pid)) return true;
    await delay(Math.min(20, Math.max(1, deadline - Date.now())));
  }
  return false;
}

function signalProcessTree(child, signal) {
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
    if (error?.code !== "ESRCH") throw error;
  }
}

export class PiRpcClient {
  #child;
  #completedIds = new Set();
  #decoder;
  #events = [];
  #eventListeners = new Set();
  #eventWaiters = new Set();
  #exit;
  #exitResolve;
  #fault;
  #invocation;
  #nextId = 0;
  #options;
  #pending = new Map();
  #protocolFrames = [];
  #state = "new";
  #stderr = Buffer.alloc(0);

  constructor(options = {}) {
    this.#options = { ...DEFAULTS, ...options };
    this.#invocation = buildPiInvocation(options);
    this.#exit = new Promise((resolve) => {
      this.#exitResolve = resolve;
    });
    this.#decoder = new StrictJsonlDecoder((line, metadata) => this.#handleFrame(line, metadata), {
      maxFrameBytes: this.#options.maxFrameBytes,
    });
  }

  get commandSource() {
    return this.#invocation.source;
  }

  get events() {
    return [...this.#events];
  }

  get processId() {
    return this.#child?.pid;
  }

  get protocolFrames() {
    return structuredClone(this.#protocolFrames);
  }

  get stderr() {
    return this.#stderr.toString("utf8");
  }

  get state() {
    return this.#state;
  }

  async start() {
    if (this.#state !== "new") throw new GateCError("CLIENT_STATE", "RPC client already started");
    const prepared = prepareSpawn(this.#invocation, { env: this.#options.env });
    const spawnProcess = this.#options.spawnProcess ?? spawn;
    const child = spawnProcess(prepared.command, prepared.args, {
      cwd: this.#options.cwd,
      env: this.#options.env ?? process.env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: prepared.windowsVerbatimArguments,
    });
    this.#child = child;
    this.#state = "running";

    child.stdout.on("data", (chunk) => {
      try {
        this.#decoder.push(chunk);
      } catch (error) {
        this.#protocolFault(asGateCError(error, "INVALID_UTF8"));
      }
    });
    child.stdout.on("end", () => {
      try {
        this.#decoder.end();
      } catch (error) {
        this.#protocolFault(asGateCError(error, "INVALID_UTF8"));
      }
      setTimeout(() => {
        if (this.#state === "running" && this.#pending.size > 0 && !this.#fault) {
          this.#protocolFault(
            new GateCError("PROTOCOL_EOF", "Pi RPC stdout ended with pending requests"),
          );
        }
      }, this.#options.protocolEofGraceMs);
    });
    child.stderr.on("data", (chunk) => {
      this.#stderr = boundedAppend(this.#stderr, chunk, this.#options.stderrLimitBytes);
    });
    child.once("error", (error) => {
      this.#processFault(new GateCError("PROCESS_START", error.message, { cause: error }));
    });
    child.once("exit", (code, signal) => {
      const fact = { code, signal };
      if (this.#state === "running" && !this.#fault) {
        this.#processFault(
          new GateCError("PROCESS_EXIT", `Pi RPC exited (code=${code}, signal=${signal})`, fact),
        );
      }
      this.#state = "closed";
      this.#exitResolve(fact);
    });

    await Promise.race([
      new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      }),
      delay(this.#options.commandTimeoutMs).then(() => {
        throw new GateCError("PROCESS_START_TIMEOUT", "Timed out starting Pi RPC");
      }),
    ]);
    return this;
  }

  onEvent(listener) {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  waitForEvent(predicate, { timeoutMs = this.#options.commandTimeoutMs, signal } = {}) {
    const existing = this.#events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.#eventWaiters.delete(waiter);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new GateCError("EVENT_TIMEOUT", "Timed out waiting for Pi RPC event"));
      }, timeoutMs);
      const onAbort = () => {
        cleanup();
        reject(new GateCError("REQUEST_ABORTED", "Event wait was aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      waiter.resolve = (event) => {
        cleanup();
        resolve(event);
      };
      waiter.reject = (error) => {
        cleanup();
        reject(error);
      };
      this.#eventWaiters.add(waiter);
    });
  }

  async send(command, options = {}) {
    if (this.#fault) throw this.#fault;
    if (this.#state !== "running" || !this.#child?.stdin.writable) {
      throw new GateCError("CLIENT_CLOSED", "Pi RPC client is not writable");
    }
    const id = `gate-c-${++this.#nextId}`;
    const timeoutMs = options.timeoutMs ?? this.#options.commandTimeoutMs;
    const fullCommand = { ...command, id };
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        this.#pending.delete(id);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new GateCError("REQUEST_TIMEOUT", `Timed out waiting for '${command.type}' response`, {
            id,
          }),
        );
      }, timeoutMs);
      const onAbort = () => {
        cleanup();
        reject(new GateCError("REQUEST_ABORTED", `Request '${command.type}' was aborted`, { id }));
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(id, {
        command: command.type,
        resolve: (response) => {
          cleanup();
          resolve(response);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      this.write(fullCommand).catch((error) => {
        const pending = this.#pending.get(id);
        if (pending) pending.reject(asGateCError(error, "STDIN_WRITE"));
      });
    });
  }

  async write(value) {
    if (this.#fault) throw this.#fault;
    if (this.#state !== "running" || !this.#child?.stdin.writable) {
      throw new GateCError("CLIENT_CLOSED", "Pi RPC client is not writable");
    }
    const frame = { direction: "stdin", value, capturedAt: Date.now() };
    this.#protocolFrames.push(structuredClone(frame));
    this.#options.onProtocolFrame?.(frame);
    const bytes = serializeJsonLine(value);
    if (this.#child.stdin.write(bytes)) return;
    await new Promise((resolve, reject) => {
      this.#child.stdin.once("drain", resolve);
      this.#child.stdin.once("error", reject);
    });
  }

  async close() {
    if (["closed", "new"].includes(this.#state)) return this.#exit;
    if (this.#state === "closing") return this.#exit;
    this.#state = "closing";

    if (this.#pending.size > 0) await delay(this.#options.pendingCloseMs);
    if (this.#pending.size > 0) {
      this.#rejectPending(
        new GateCError("CLIENT_CLOSING", "RPC client closed with pending requests"),
      );
    }

    if (this.#child?.stdin.writable) this.#child.stdin.end();
    let exited = await waitForProcessTreeExit(this.#child, this.#options.closeGraceMs);
    if (!exited) {
      signalProcessTree(this.#child, "SIGTERM");
      exited = await waitForProcessTreeExit(this.#child, this.#options.forceGraceMs);
    }
    if (!exited) {
      signalProcessTree(this.#child, "SIGKILL");
      exited = await waitForProcessTreeExit(this.#child, this.#options.forceGraceMs);
    }
    if (!exited) {
      throw new GateCError(
        "PROCESS_CLEANUP",
        "Pi RPC process tree did not exit within cleanup bounds",
      );
    }
    return this.#exit;
  }

  #handleFrame(line, metadata) {
    if (line.length === 0) return;
    let value;
    try {
      value = JSON.parse(line);
    } catch (error) {
      this.#protocolFault(
        new GateCError("MALFORMED_FRAME", "Pi RPC stdout contained malformed JSON", {
          diagnostic: line.slice(0, 256),
          unterminated: metadata.unterminated,
          cause: error,
        }),
      );
      return;
    }
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      typeof value.type !== "string"
    ) {
      this.#protocolFault(
        new GateCError("INVALID_ENVELOPE", "Pi RPC frame is not an object envelope"),
      );
      return;
    }
    const frame = {
      direction: "stdout",
      value,
      capturedAt: Date.now(),
      unterminated: metadata.unterminated,
    };
    this.#protocolFrames.push(structuredClone(frame));
    this.#options.onProtocolFrame?.(frame);
    if (value.type === "response") {
      if (typeof value.id !== "string") {
        this.#protocolFault(
          new GateCError("UNKNOWN_RESPONSE", "Pi RPC response has no request id"),
        );
        return;
      }
      const pending = this.#pending.get(value.id);
      if (!pending) {
        const code = this.#completedIds.has(value.id) ? "DUPLICATE_RESPONSE" : "UNKNOWN_RESPONSE";
        this.#protocolFault(
          new GateCError(code, `Pi RPC response id '${value.id}' is not pending`),
        );
        return;
      }
      this.#completedIds.add(value.id);
      pending.resolve(value);
      return;
    }
    this.#events.push(value);
    for (const listener of this.#eventListeners) listener(value);
    for (const waiter of [...this.#eventWaiters]) {
      if (waiter.predicate(value)) waiter.resolve(value);
    }
  }

  #protocolFault(error) {
    if (this.#fault) return;
    this.#fault = error;
    this.#rejectPending(error);
    for (const waiter of this.#eventWaiters) waiter.reject(error);
  }

  #processFault(error) {
    if (!this.#fault) this.#fault = error;
    this.#rejectPending(this.#fault);
    for (const waiter of this.#eventWaiters) waiter.reject(this.#fault);
  }

  #rejectPending(error) {
    for (const pending of [...this.#pending.values()]) pending.reject(error);
    this.#pending.clear();
  }
}
