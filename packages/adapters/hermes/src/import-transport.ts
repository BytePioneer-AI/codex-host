import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { sanitizeDiagnosticTail } from "@codexhost/harness-adapter";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
} from "@agentclientprotocol/sdk";
import { commandInvocation } from "@codexhost/harness-discovery";
import { HermesExecutableError, resolveHermesExecutable } from "./command.js";
import { HermesTransportError, withTimeout } from "./hermes-transport.js";

export interface HermesImportTransportOptions {
  cwd: string;
  command?: string;
  environment?: NodeJS.ProcessEnv;
  commandTimeoutMs?: number;
  closeTimeoutMs?: number;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function classifyStartupError(error: unknown): HermesTransportError {
  if (error instanceof HermesTransportError) return error;
  if (error instanceof HermesExecutableError)
    return new HermesTransportError("notInstalled", error.message, { cause: error });
  const detail =
    isRecord(error) &&
    isRecord(error.data) &&
    typeof error.data.details === "string" &&
    error.data.details.trim()
      ? error.data.details.trim()
      : error instanceof Error
        ? error.message
        : String(error);
  const text = detail.toLowerCase();
  const kind = [
    "auth_required",
    "authentication",
    "not configured",
    "no provider",
    "no llm provider",
  ].some((value) => text.includes(value))
    ? "authenticationRequired"
    : "unavailable";
  return new HermesTransportError(kind, detail, { cause: error, diagnostic: detail });
}
function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return Promise.race([
    new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
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

/** ACP is retained only for session/list import discovery, never for chat Sessions. */
export class HermesImportTransport {
  #options: HermesImportTransportOptions;
  #child: ChildProcessWithoutNullStreams | null = null;
  #closed = false;
  #stderrTail = "";
  constructor(options: HermesImportTransportOptions) {
    this.#options = options;
  }
  async probeConnection(): Promise<ClientSideConnection> {
    if (this.#child || this.#closed)
      throw new Error("Hermes import discovery cannot be started twice");
    try {
      const executable = resolveHermesExecutable({
        ...(this.#options.command ? { command: this.#options.command } : {}),
        environment: this.#options.environment ?? process.env,
      });
      const invocation = commandInvocation(executable, ["acp"], process.env, process.platform);
      const child = spawn(invocation.command, invocation.arguments, {
        cwd: this.#options.cwd,
        env: { ...process.env, ...this.#options.environment },
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      });
      this.#child = child;
      child.stderr.on("data", (chunk: Buffer | string) => {
        this.#stderrTail = sanitizeDiagnosticTail(`${this.#stderrTail}${chunk.toString()}`);
      });
      const timeoutMs = this.#options.commandTimeoutMs ?? 30_000;
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          child.once("spawn", resolve);
          child.once("error", reject);
        }),
        timeoutMs,
        "Hermes CLI startup",
      );
      const stream = ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      );
      const connection = new ClientSideConnection(
        () =>
          ({
            sessionUpdate: async () => undefined,
            requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
          }) satisfies Client,
        stream,
      );
      await withTimeout(
        connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: "codexhost", version: "0.1.0" },
        }),
        timeoutMs,
        "Hermes ACP import initialize",
      );
      return connection;
    } catch (error) {
      throw classifyStartupError(error);
    }
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const child = this.#child;
    const timeoutMs = this.#options.closeTimeoutMs ?? 2_000;
    if (child?.stdin.writable) child.stdin.end();
    if (child && !(await waitForExit(child, timeoutMs))) {
      signalProcessTree(child, "SIGTERM");
      if (!(await waitForExit(child, timeoutMs))) {
        signalProcessTree(child, "SIGKILL");
        await waitForExit(child, timeoutMs);
      }
    }
  }
}
