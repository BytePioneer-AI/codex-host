import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access } from "node:fs/promises";
import { createInterface } from "node:readline";
import { sanitizeDiagnosticTail } from "@codexhost/harness-adapter";
import { inventoryPythonCandidates, venvPythonFromShim } from "./hermes-inventory.js";
import { prepareGatewayDelegation } from "./gateway-delegation.js";
import { withTimeout, HermesTransportError } from "./acp-transport.js";

export type GatewayRecord = Record<string, unknown>;
export function gatewayRecord(value: unknown): GatewayRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as GatewayRecord)
    : {};
}
export function gatewayString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// Compatibility is determined by native capabilities and RPC results, not version numbers.
const GATEWAY_LAUNCH = `import runpy\nrunpy.run_module('tui_gateway.entry', run_name='__main__')`;

export class HermesGatewayTransport {
  onEvent: (event: GatewayRecord) => void = () => undefined;
  onRequest: (id: string, method: string, params: GatewayRecord) => void = (id) =>
    this.rejectRequest(id);
  onFault: (error: Error) => void = () => undefined;
  #child: ChildProcessWithoutNullStreams | null = null;
  #nextId = 0;
  #pending = new Map<string, { resolve(value: GatewayRecord): void; reject(error: Error): void }>();
  #closed = false;
  #closePromise: Promise<void> | null = null;
  #processClosed: Promise<void> = Promise.resolve();
  #sessionErrors = new Map<string, Error>();
  #sessionReady = new Map<string, GatewayRecord>();
  #sessionWaiters = new Map<
    string,
    { resolve(value: GatewayRecord): void; reject(error: Error): void }
  >();
  #stderr = "";
  #delegation: Awaited<ReturnType<typeof prepareGatewayDelegation>> | undefined;
  constructor(
    readonly python: string,
    readonly cwd: string,
    readonly environment: NodeJS.ProcessEnv,
    readonly timeoutMs = 30_000,
  ) {}

  static async probe(
    executable: string,
    cwd: string,
    environment: NodeJS.ProcessEnv,
  ): Promise<string | null> {
    const shim = await venvPythonFromShim(executable);
    const candidates = [
      ...new Set(
        [
          environment.CODEXHOST_HERMES_GATEWAY_PYTHON,
          shim,
          ...inventoryPythonCandidates(executable),
        ].filter((candidate): candidate is string => !!candidate),
      ),
    ];
    for (const candidate of candidates) {
      try {
        await access(candidate);
      } catch {
        continue;
      }
      const transport = new HermesGatewayTransport(candidate, cwd, environment, 20_000);
      try {
        await transport.start();
        return candidate;
      } catch {
        /* Installations without a usable gateway keep their ACP path. */
      } finally {
        await transport.close();
      }
    }
    return null;
  }

  async prepareSession(): Promise<void> {
    if (this.#child || this.#closed)
      throw new Error("Hermes gateway Session cannot be prepared after start");
    const prepared = await prepareGatewayDelegation(this.environment);
    if (this.#closed) {
      await prepared.dispose();
      throw new Error("Hermes gateway closed during Session preparation");
    }
    this.#delegation = prepared;
  }
  async start(): Promise<void> {
    if (this.#child || this.#closed) throw new Error("Hermes gateway cannot be started twice");
    const child = spawn(
      this.python,
      ["-I", "-u", "-c", (this.#delegation?.bootstrap ?? "") + GATEWAY_LAUNCH],
      {
        cwd: this.cwd,
        env: {
          ...process.env,
          ...(this.#delegation?.environment ?? this.environment),
          HERMES_TUI_TOOL_PROGRESS: "all",
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      },
    );
    this.#child = child;
    this.#processClosed = new Promise((resolve) => child.once("close", () => resolve()));
    child.stderr.on("data", (data: Buffer) => {
      this.#stderr = sanitizeDiagnosticTail(this.#stderr + data.toString());
    });
    child.stdin.on("error", (error) => this.#fault(error));
    child.once("error", (error) => this.#fault(error));
    child.once("exit", () => {
      if (!this.#closed) this.#fault(new Error(`Hermes gateway exited: ${this.#stderr}`));
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        this.#frame(gatewayRecord(JSON.parse(line)));
      } catch (error) {
        this.#fault(error instanceof Error ? error : new Error(String(error)));
      }
    });
    const capabilities = await this.request("gateway.capabilities", {});
    if (capabilities.per_session_exclusive_submit !== true)
      throw new Error("Hermes gateway does not enforce exclusive turns");
  }

  async waitForSession(sessionId: string): Promise<GatewayRecord> {
    const error = this.#sessionErrors.get(sessionId);
    if (error) throw error;
    const ready = this.#sessionReady.get(sessionId);
    if (ready) return ready;
    const result = new Promise<GatewayRecord>((resolve, reject) =>
      this.#sessionWaiters.set(sessionId, { resolve, reject }),
    );
    try {
      return await withTimeout(result, this.timeoutMs, "Hermes gateway agent initialization");
    } finally {
      this.#sessionWaiters.delete(sessionId);
    }
  }

  async request(
    method: string,
    params: GatewayRecord,
    timeoutMs = this.timeoutMs,
  ): Promise<GatewayRecord> {
    if (this.#closed || !this.#child) throw new Error("Hermes gateway is closed");
    const id = `codexhost-${++this.#nextId}`;
    const response = new Promise<GatewayRecord>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
    try {
      return await withTimeout(response, timeoutMs, `Hermes ${method}`);
    } catch (error) {
      if (error instanceof HermesTransportError) this.#fault(error);
      throw error;
    } finally {
      this.#pending.delete(id);
    }
  }
  respond(id: string, result: GatewayRecord): void {
    this.#send({ jsonrpc: "2.0", id, result });
  }
  rejectRequest(id: string): void {
    this.#send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "Unsupported Host interaction" },
    });
  }
  #send(frame: GatewayRecord): void {
    if (!this.#child?.stdin.writable) throw new Error("Hermes gateway input is closed");
    this.#child.stdin.write(JSON.stringify(frame) + "\n");
  }
  #frame(frame: GatewayRecord): void {
    if (frame.method === "event") {
      const event = gatewayRecord(frame.params);
      const sessionId = gatewayString(event.session_id);
      const payload = gatewayRecord(event.payload);
      if (event.type === "session.info" && payload.lazy !== true) {
        this.#sessionReady.set(sessionId, payload);
        this.#sessionWaiters.get(sessionId)?.resolve(payload);
      } else if (event.type === "error") {
        const error = new Error(gatewayString(payload.message));
        this.#sessionErrors.set(sessionId, error);
        this.#sessionWaiters.get(sessionId)?.reject(error);
      }
      this.onEvent(event);
      return;
    }
    if (typeof frame.method === "string" && typeof frame.id === "string") {
      this.onRequest(frame.id, frame.method, gatewayRecord(frame.params));
      return;
    }
    const id = gatewayString(frame.id);
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    if (frame.error)
      pending.reject(
        new Error(
          gatewayString(gatewayRecord(frame.error).message) || "Hermes gateway request failed",
        ),
      );
    else pending.resolve(gatewayRecord(frame.result));
  }
  #fault(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    for (const waiter of this.#sessionWaiters.values()) waiter.reject(error);
    this.#sessionWaiters.clear();
    this.#pending.clear();
    if (!this.#closed) {
      this.onFault(error);
      void this.close();
    }
  }
  #signal(signal: NodeJS.Signals): void {
    const pid = this.#child?.pid;
    if (!pid) return;
    if (process.platform === "win32") {
      spawnSync("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      return;
    }
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if (gatewayRecord(error).code !== "ESRCH") throw error;
    }
  }
  close(): Promise<void> {
    return (this.#closePromise ??= this.#close().finally(() => this.#delegation?.dispose()));
  }
  async #close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#fault(new Error("Hermes gateway closed"));
    const child = this.#child;
    if (!child) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      this.#signal("SIGKILL");
      return;
    }
    const exit = this.#processClosed;
    child.stdin.end();
    try {
      await withTimeout(exit, 2000, "Hermes gateway close");
    } catch {
      this.#signal("SIGTERM");
      try {
        await withTimeout(exit, 2000, "Hermes gateway exit");
      } catch {
        this.#signal("SIGKILL");
        await withTimeout(exit, 2000, "Hermes gateway killed").catch(() => undefined);
      }
    }
  }
}
