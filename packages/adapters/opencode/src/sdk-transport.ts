import { randomBytes } from "node:crypto";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";

import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { QuestionAnswer, SessionStatus } from "@opencode-ai/sdk/v2";

import { sanitizeDiagnosticTail } from "@codexhost/harness-adapter";

import {
  OpenCodeExecutableError,
  openCodeServerInvocation,
  resolveOpenCodeExecutable,
} from "./command.js";
import type { OpenCodeMessageWithParts } from "./history.js";
import type { OpenCodeNativeModelRef } from "./model-catalog.js";
import {
  OpenCodeTransportError,
  type OpenCodeCommandInput,
  type OpenCodePromptInput,
  type OpenCodeProviderCatalogResponse,
  type OpenCodeTransport,
  type OpenCodeTransportListener,
} from "./protocol.js";

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
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 3_000;
const DEFAULT_RECONNECT_DELAY_MS = 500;
const DEFAULT_RECONNECT_ATTEMPTS = 3;
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

function responseAccepted(response: { data: unknown; error: unknown }, operation: string): void {
  if (response.error !== undefined) throw classifySdkError(response.error, operation);
  if (!("data" in response)) {
    throw new OpenCodeTransportError(
      "protocolError",
      `OpenCode ${operation} response did not contain data`,
    );
  }
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

export class SdkOpenCodeTransport implements OpenCodeTransport {
  readonly cwd: string;
  readonly #commandTimeoutMs: number;
  readonly #connection: OpenCodeServerConnectionLike;
  readonly #reconnectAttempts: number;
  readonly #reconnectDelayMs: number;
  #abort: AbortController | null = null;
  #client: Promise<OpencodeClient> | null = null;
  #listener: OpenCodeTransportListener | null = null;
  #pump: Promise<void> | null = null;

  constructor(
    connection: OpenCodeServerConnectionLike,
    cwd: string,
    options: OpenCodeServerOptions = {},
  ) {
    this.#connection = connection;
    this.cwd = cwd;
    this.#commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.#reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.#reconnectAttempts = options.reconnectAttempts ?? DEFAULT_RECONNECT_ATTEMPTS;
  }

  get stderrTail(): string {
    return this.#connection.stderrTail;
  }

  async health() {
    const client = await this.#getClient();
    return responseData<{ healthy: true; version: string }>(
      await withTimeout(client.global.health(), this.#commandTimeoutMs, "OpenCode health check"),
      "health check",
    );
  }

  async providers(): Promise<OpenCodeProviderCatalogResponse> {
    const client = await this.#getClient();
    return responseData(
      await withTimeout(client.provider.list(), this.#commandTimeoutMs, "OpenCode Provider list"),
      "Provider list",
    );
  }

  async commands() {
    const client = await this.#getClient();
    return responseData(
      await withTimeout(client.command.list(), this.#commandTimeoutMs, "OpenCode Command list"),
      "Command list",
    );
  }

  async createSession(input: { model?: OpenCodeNativeModelRef; variant?: string } = {}) {
    const client = await this.#getClient();
    return responseData(
      await withTimeout(
        client.session.create({
          ...(input.model
            ? {
                model: {
                  id: input.model.modelID,
                  providerID: input.model.providerID,
                  ...(input.variant ? { variant: input.variant } : {}),
                },
              }
            : {}),
        }),
        this.#commandTimeoutMs,
        "OpenCode Session create",
      ),
      "Session create",
    );
  }

  async deleteSession(sessionID: string): Promise<void> {
    const client = await this.#getClient();
    responseData(
      await withTimeout(
        client.session.delete({ sessionID }),
        this.#commandTimeoutMs,
        "OpenCode Session delete",
      ),
      "Session delete",
    );
  }

  async getSession(sessionID: string) {
    const client = await this.#getClient();
    return responseData(
      await withTimeout(
        client.session.get({ sessionID }),
        this.#commandTimeoutMs,
        "OpenCode Session read",
      ),
      "Session read",
    );
  }

  async getMessages(sessionID: string): Promise<OpenCodeMessageWithParts[]> {
    const client = await this.#getClient();
    return responseData(
      await withTimeout(
        client.session.messages({ sessionID }),
        this.#commandTimeoutMs,
        "OpenCode transcript read",
      ),
      "transcript read",
    );
  }

  async getStatus(sessionID: string) {
    const client = await this.#getClient();
    const statuses = responseData<Record<string, SessionStatus>>(
      await withTimeout(client.session.status(), this.#commandTimeoutMs, "OpenCode Session status"),
      "Session status",
    );
    return statuses[sessionID] ?? { type: "idle" as const };
  }

  async getDiff(sessionID: string, messageID?: string) {
    const client = await this.#getClient();
    return responseData(
      await withTimeout(
        client.session.diff({ sessionID, ...(messageID ? { messageID } : {}) }),
        this.#commandTimeoutMs,
        "OpenCode Session diff",
      ),
      "Session diff",
    );
  }

  async forkSession(sessionID: string, messageID?: string) {
    const client = await this.#getClient();
    return responseData(
      await withTimeout(
        client.session.fork({ sessionID, ...(messageID ? { messageID } : {}) }),
        this.#commandTimeoutMs,
        "OpenCode Session fork",
      ),
      "Session fork",
    );
  }

  async revertSession(sessionID: string, messageID: string) {
    const client = await this.#getClient();
    return responseData(
      await withTimeout(
        client.session.revert({ sessionID, messageID }),
        this.#commandTimeoutMs,
        "OpenCode Session revert",
      ),
      "Session revert",
    );
  }

  async unrevertSession(sessionID: string) {
    const client = await this.#getClient();
    return responseData(
      await withTimeout(
        client.session.unrevert({ sessionID }),
        this.#commandTimeoutMs,
        "OpenCode Session unrevert",
      ),
      "Session unrevert",
    );
  }

  async promptAsync(input: OpenCodePromptInput): Promise<void> {
    const client = await this.#getClient();
    responseAccepted(
      await withTimeout(
        client.session.promptAsync({
          sessionID: input.sessionID,
          messageID: input.messageID,
          ...(input.model ? { model: input.model } : {}),
          ...(input.variant ? { variant: input.variant } : {}),
          parts: [{ type: "text", text: input.text }],
        }),
        this.#commandTimeoutMs,
        "OpenCode prompt admission",
      ),
      "prompt admission",
    );
  }

  async executeCommand(input: OpenCodeCommandInput): Promise<void> {
    const client = await this.#getClient();
    responseData(
      await withTimeout(
        client.session.command({
          sessionID: input.sessionID,
          messageID: input.messageID,
          command: input.command,
          arguments: input.arguments,
          ...(input.model ? { model: `${input.model.providerID}/${input.model.modelID}` } : {}),
          ...(input.variant ? { variant: input.variant } : {}),
        }),
        this.#commandTimeoutMs,
        "OpenCode command admission",
      ),
      "command admission",
    );
  }

  async summarize(sessionID: string, model?: OpenCodeNativeModelRef): Promise<void> {
    const client = await this.#getClient();
    responseData(
      await withTimeout(
        client.session.summarize({
          sessionID,
          ...(model ? { providerID: model.providerID, modelID: model.modelID } : {}),
        }),
        this.#commandTimeoutMs,
        "OpenCode context compaction",
      ),
      "context compaction",
    );
  }

  async abort(sessionID: string): Promise<void> {
    const client = await this.#getClient();
    responseData(
      await withTimeout(
        client.session.abort({ sessionID }),
        this.#commandTimeoutMs,
        "OpenCode Session abort",
      ),
      "Session abort",
    );
  }

  async listQuestions() {
    const client = await this.#getClient();
    return responseData(
      await withTimeout(client.question.list(), this.#commandTimeoutMs, "OpenCode Question list"),
      "Question list",
    );
  }

  async replyQuestion(requestID: string, answers: QuestionAnswer[]): Promise<void> {
    const client = await this.#getClient();
    responseData(
      await withTimeout(
        client.question.reply({ requestID, answers }),
        this.#commandTimeoutMs,
        "OpenCode Question reply",
      ),
      "Question reply",
    );
  }

  async rejectQuestion(requestID: string): Promise<void> {
    const client = await this.#getClient();
    responseData(
      await withTimeout(
        client.question.reject({ requestID }),
        this.#commandTimeoutMs,
        "OpenCode Question reject",
      ),
      "Question reject",
    );
  }

  async listPermissions() {
    const client = await this.#getClient();
    return responseData(
      await withTimeout(
        client.permission.list(),
        this.#commandTimeoutMs,
        "OpenCode Permission list",
      ),
      "Permission list",
    );
  }

  async replyPermission(requestID: string, reply: "once" | "reject"): Promise<void> {
    const client = await this.#getClient();
    responseData(
      await withTimeout(
        client.permission.reply({ requestID, reply }),
        this.#commandTimeoutMs,
        "OpenCode Permission reply",
      ),
      "Permission reply",
    );
  }

  async subscribe(listener: OpenCodeTransportListener): Promise<void> {
    if (this.#listener) {
      throw new OpenCodeTransportError("protocolError", "OpenCode transport is already subscribed");
    }
    this.#listener = listener;
    this.#abort = new AbortController();
    let readyResolve = (): void => undefined;
    let readyReject: (error: unknown) => void = () => undefined;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    this.#pump = this.#pumpEvents(listener, this.#abort.signal, readyResolve).catch((error) => {
      const normalized = classifySdkError(error, "event stream");
      readyReject(normalized);
      if (!this.#abort?.signal.aborted) listener.onFault(normalized);
    });
    await withTimeout(ready, this.#commandTimeoutMs, "OpenCode event subscription");
  }

  async close(): Promise<void> {
    this.#abort?.abort();
    await this.#pump?.catch(() => undefined);
    this.#listener = null;
    this.#abort = null;
    this.#pump = null;
  }

  #getClient(): Promise<OpencodeClient> {
    this.#client ??= this.#connection.client(this.cwd);
    return this.#client;
  }

  async #pumpEvents(
    listener: OpenCodeTransportListener,
    signal: AbortSignal,
    initialReady: () => void,
  ): Promise<void> {
    let connectedOnce = false;
    let failures = 0;
    while (!signal.aborted) {
      try {
        const client = await this.#getClient();
        const events = await client.event.subscribe(undefined, { signal });
        let connectedThisAttempt = false;
        for await (const event of events.stream) {
          if (signal.aborted) return;
          if (event.type === "server.connected") {
            connectedThisAttempt = true;
            failures = 0;
            if (!connectedOnce) {
              connectedOnce = true;
              initialReady();
            }
          }
          listener.onEvent(event);
        }
        if (signal.aborted) return;
        if (!connectedThisAttempt) {
          throw new OpenCodeTransportError(
            "protocolError",
            "OpenCode event stream ended before server.connected",
          );
        }
        throw new OpenCodeTransportError("unavailable", "OpenCode event stream disconnected");
      } catch (error) {
        if (signal.aborted) return;
        failures += 1;
        if (failures > this.#reconnectAttempts) throw error;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.#reconnectDelayMs);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
    }
  }
}
