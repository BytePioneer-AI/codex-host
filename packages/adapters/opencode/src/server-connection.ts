import { randomBytes } from "node:crypto";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";

import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client";

import { sanitizeDiagnosticTail } from "@codexhost/harness-adapter";

import {
  OpenCodeExecutableError,
  openCodeServerInvocation,
  resolveOpenCodeExecutable,
} from "./command.js";
import { OpenCodeTransportError } from "./protocol.js";

export interface OpenCodeServerOptions {
  command?: string;
  environment?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  commandTimeoutMs?: number;
  closeTimeoutMs?: number;
  reconnectDelayMs?: number;
  reconnectAttempts?: number;
}

interface SpawnOptions {
  env: NodeJS.ProcessEnv;
  stdio: "pipe";
  detached: boolean;
  windowsHide: boolean;
  windowsVerbatimArguments?: boolean;
}

export interface OpenCodeServerDependencies {
  createClient(options: {
    baseUrl: string;
    directory?: string;
    headers: Record<string, string>;
  }): OpencodeClient;
  randomPassword(): string;
  spawn(command: string, args: string[], options: SpawnOptions): ChildProcessWithoutNullStreams;
  sleep(milliseconds: number): Promise<void>;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 3_000;
const SERVER_USERNAME = "codexhost";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingExecutable(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function classifySdkError(error: unknown, operation: string): OpenCodeTransportError {
  if (error instanceof OpenCodeTransportError) return error;
  const text = errorText(error);
  const lower = text.toLowerCase();
  if (lower.includes("unauthorized") || lower.includes("authentication")) {
    return new OpenCodeTransportError(
      "authenticationRequired",
      `OpenCode ${operation} requires authentication`,
      { cause: error },
    );
  }
  return new OpenCodeTransportError("unavailable", `OpenCode ${operation} failed: ${text}`, {
    cause: error,
  });
}

function responseData<T>(response: { data: T | undefined; error: unknown }, operation: string): T {
  if (response.error !== undefined) throw classifySdkError(response.error, operation);
  if (!("data" in response) || response.data === undefined) {
    throw new OpenCodeTransportError(
      "protocolError",
      `OpenCode ${operation} response did not contain data`,
    );
  }
  return response.data as T;
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, operation: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new OpenCodeTransportError("unavailable", `${operation} timed out`)),
        milliseconds,
      );
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
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

export interface OpenCodeServerConnectionLike {
  readonly stderrTail: string;
  client(cwd?: string): Promise<OpencodeClient>;
  close(): Promise<void>;
}

export function managedOpenCodeEnvironment(
  environment: Record<string, string | undefined> | undefined,
  executionPolicy: "default" | "unattended-full-access" = "default",
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...(environment ?? process.env) };
  const undefinedKeys = Object.entries(merged)
    .filter(([, value]) => value === undefined)
    .map(([key]) => key);
  for (const key of undefinedKeys) {
    Reflect.deleteProperty(merged, key);
  }
  if (executionPolicy === "unattended-full-access") {
    const existing = merged.OPENCODE_CONFIG_CONTENT;
    let config: Record<string, unknown> = {};
    if (existing !== undefined) {
      try {
        const parsed: unknown = JSON.parse(existing);
        if (!isRecord(parsed)) throw new Error("OpenCode config content must be an object");
        config = { ...parsed };
      } catch (error) {
        throw new OpenCodeTransportError(
          "unavailable",
          "OpenCode unattended execution requires valid JSON OPENCODE_CONFIG_CONTENT",
          { cause: error },
        );
      }
    }
    // This environment belongs to one managed Server only. Never use the
    // shared process-wide `always` reply; `allow` is the native config action
    // applied before this dedicated Server accepts any Session.
    merged.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...config, permission: "allow" });
  }
  return merged;
}

export class OpenCodeServerConnection implements OpenCodeServerConnectionLike {
  readonly #closeTimeoutMs: number;
  readonly #dependencies: OpenCodeServerDependencies;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #options: OpenCodeServerOptions;
  readonly #startupTimeoutMs: number;
  #child: ChildProcessWithoutNullStreams | null = null;
  #closePromise: Promise<void> | null = null;
  #connection: Promise<{ baseUrl: string; authorization: string }> | null = null;
  #stderrTail = "";

  constructor(
    options: OpenCodeServerOptions = {},
    dependencies: OpenCodeServerDependencies = {
      createClient: (input) => createOpencodeClient(input),
      randomPassword: () => randomBytes(32).toString("base64url"),
      spawn: (command, args, spawnOptions) =>
        spawn(command, args, {
          ...spawnOptions,
          windowsVerbatimArguments: spawnOptions.windowsVerbatimArguments,
        }),
      sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    },
  ) {
    this.#options = options;
    this.#environment = options.environment ?? process.env;
    this.#startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.#closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this.#dependencies = dependencies;
  }

  get stderrTail(): string {
    return this.#stderrTail;
  }

  async client(cwd?: string): Promise<OpencodeClient> {
    const connection = await this.#connect();
    return this.#dependencies.createClient({
      baseUrl: connection.baseUrl,
      ...(cwd ? { directory: cwd } : {}),
      headers: { Authorization: connection.authorization },
    });
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#performClose();
    return this.#closePromise;
  }

  #connect(): Promise<{ baseUrl: string; authorization: string }> {
    if (this.#closePromise) {
      return Promise.reject(
        new OpenCodeTransportError("unavailable", "OpenCode Server connection is closing"),
      );
    }
    if (!this.#connection) {
      const connection = this.#start();
      this.#connection = connection;
      void connection.catch(() => {
        if (this.#connection === connection) this.#connection = null;
      });
    }
    return this.#connection;
  }

  async #start(): Promise<{ baseUrl: string; authorization: string }> {
    let executable: string;
    try {
      executable = resolveOpenCodeExecutable({
        ...(this.#options.command ? { command: this.#options.command } : {}),
        environment: this.#environment,
      });
    } catch (error) {
      if (error instanceof OpenCodeExecutableError) {
        throw new OpenCodeTransportError("notInstalled", error.message, { cause: error });
      }
      throw error;
    }
    const password = this.#dependencies.randomPassword();
    const environment = {
      ...this.#environment,
      OPENCODE_SERVER_USERNAME: SERVER_USERNAME,
      OPENCODE_SERVER_PASSWORD: password,
    };
    const invocation = openCodeServerInvocation(executable, environment);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.#dependencies.spawn(invocation.command, invocation.arguments, {
        env: environment,
        stdio: "pipe",
        detached: process.platform !== "win32",
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      });
    } catch (error) {
      throw new OpenCodeTransportError(
        isMissingExecutable(error) ? "notInstalled" : "unavailable",
        isMissingExecutable(error)
          ? "OpenCode CLI is not installed"
          : "OpenCode Server failed to start",
        { cause: error },
      );
    }
    this.#child = child;
    child.once("exit", () => {
      if (this.#child !== child) return;
      this.#child = null;
      this.#connection = null;
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.#stderrTail = sanitizeDiagnosticTail(`${this.#stderrTail}${chunk.toString()}`);
    });
    const address = new Promise<string>((resolve, reject) => {
      let output = "";
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        callback();
      };
      child.stdout.on("data", (chunk: Buffer | string) => {
        output += chunk.toString();
        const lines = output.split(/\r?\n/u);
        output = lines.pop() ?? "";
        for (const line of lines) {
          const match = line.match(
            /^opencode server listening on (http:\/\/127\.0\.0\.1:\d+)\s*$/u,
          );
          const baseUrl = match?.[1];
          if (baseUrl) finish(() => resolve(baseUrl));
        }
      });
      child.once("error", (error) =>
        finish(() =>
          reject(
            new OpenCodeTransportError(
              isMissingExecutable(error) ? "notInstalled" : "unavailable",
              isMissingExecutable(error)
                ? "OpenCode CLI is not installed"
                : `OpenCode Server failed to start: ${error.message}`,
              { cause: error },
            ),
          ),
        ),
      );
      child.once("exit", (code, signal) =>
        finish(() =>
          reject(
            new OpenCodeTransportError(
              "processExited",
              `OpenCode Server exited before startup completed (${signal ?? code ?? "unknown"})`,
            ),
          ),
        ),
      );
    });
    try {
      const baseUrl = await withTimeout(address, this.#startupTimeoutMs, "OpenCode Server startup");
      const authorization = `Basic ${Buffer.from(`${SERVER_USERNAME}:${password}`, "utf8").toString("base64")}`;
      const client = this.#dependencies.createClient({
        baseUrl,
        headers: { Authorization: authorization },
      });
      const health = responseData<{ healthy: true; version: string }>(
        await client.global.health(),
        "health check",
      );
      if (health.healthy !== true || typeof health.version !== "string") {
        throw new OpenCodeTransportError(
          "protocolError",
          "OpenCode Server returned an invalid health response",
        );
      }
      return { baseUrl, authorization };
    } catch (error) {
      await this.#stopChild(child).catch(() => undefined);
      throw classifySdkError(error, "Server startup");
    }
  }

  async #stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    signalProcessTree(child, "SIGTERM");
    if (await waitForExit(child, this.#closeTimeoutMs)) return;
    signalProcessTree(child, "SIGKILL");
    if (!(await waitForExit(child, this.#closeTimeoutMs))) {
      throw new OpenCodeTransportError(
        "processExited",
        "OpenCode Server process tree did not exit within cleanup bounds",
      );
    }
  }

  async #performClose(): Promise<void> {
    const child = this.#child;
    if (child) await this.#stopChild(child);
    this.#connection = null;
  }
}
