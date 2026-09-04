import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import { commandInvocation, resolvePenguinExecutable, withNodeRuntimeOnPath } from "./command.js";

export interface PenguinSseFrame {
  id?: string;
  event?: string;
  data: string;
}

export interface PenguinRequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
}

export interface PenguinApiClient {
  request<T>(apiPath: string, options?: PenguinRequestOptions): Promise<T>;
  stream(
    sessionId: string,
    signal?: AbortSignal,
    lastEventId?: string,
  ): AsyncIterable<PenguinSseFrame>;
}

export interface PenguinConnection {
  readonly endpoint: string;
  readonly client: PenguinApiClient;
  close(): Promise<void>;
}

export interface PenguinConnectionOptions {
  command?: string;
  endpoint?: string;
  environment?: NodeJS.ProcessEnv;
  root?: string;
  startupTimeoutMs?: number;
  closeTimeoutMs?: number;
  autoStartServer?: boolean;
  fetchImpl?: typeof fetch;
}

export class PenguinApiError extends Error {
  constructor(
    readonly status: number,
    readonly apiCode: string,
    message: string,
  ) {
    super(message);
    this.name = "PenguinApiError";
  }
}

export class PenguinConnectionError extends Error {
  constructor(
    readonly code: "notInstalled" | "unavailable" | "authenticationRequired" | "protocolError",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "PenguinConnectionError";
  }
}

interface PenguinServerLock {
  pid: number;
  port: number;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
const DEFAULT_PENGUIN_PORT = 7_364;

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function dataRoot(environment: NodeJS.ProcessEnv, root?: string): string {
  return path.resolve(
    root ?? nonBlank(environment.PENGUIN_HOME) ?? path.join(os.homedir(), ".penguin", "data"),
  );
}

async function readLocalApiToken(root: string): Promise<string | undefined> {
  try {
    return nonBlank(await readFile(path.join(root, "api-token"), "utf8"));
  } catch {
    return undefined;
  }
}

function environmentWithRoot(environment: NodeJS.ProcessEnv, root: string): NodeJS.ProcessEnv {
  return { ...environment, PENGUIN_HOME: root };
}

function normalizeEndpoint(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch (error) {
    throw new PenguinConnectionError("protocolError", "Penguin API endpoint is not a valid URL", {
      cause: error,
    });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PenguinConnectionError(
      "protocolError",
      "Penguin API endpoint must use HTTP or HTTPS",
    );
  }
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString().replace(/\/$/u, "");
}

function isLoopbackEndpoint(endpoint: string): boolean {
  const hostname = new URL(endpoint).hostname.toLowerCase();
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readServerLock(root: string): Promise<PenguinServerLock | null> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path.join(root, "server.lock"), "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const pid = value.pid;
  const port = value.port;
  if (
    typeof pid !== "number" ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    typeof port !== "number" ||
    !Number.isSafeInteger(port) ||
    port <= 0 ||
    port > 65_535
  ) {
    return null;
  }
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (isRecord(error) && error.code === "EPERM") return { pid, port };
    return null;
  }
  return { pid, port };
}

function endpointFromLock(lock: PenguinServerLock): string {
  return `http://127.0.0.1:${lock.port}`;
}

async function waitForLock(
  root: string,
  child: ChildProcess,
  timeoutMs: number,
): Promise<PenguinServerLock> {
  const deadline = Date.now() + timeoutMs;
  let exitCode: number | null = null;
  const onExit = (code: number | null): void => {
    exitCode = code ?? -1;
  };
  child.once("exit", onExit);
  try {
    while (Date.now() < deadline) {
      const lock = await readServerLock(root);
      if (lock) return lock;
      if (exitCode !== null) {
        throw new PenguinConnectionError("unavailable", "Penguin server exited during startup");
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    child.removeListener("exit", onExit);
  }
  throw new PenguinConnectionError("unavailable", "Timed out waiting for the Penguin server");
}

function spawnEnvironment(environment: NodeJS.ProcessEnv, root: string): NodeJS.ProcessEnv {
  return withNodeRuntimeOnPath(environmentWithRoot(environment, root));
}

async function startServer(options: {
  command?: string;
  environment: NodeJS.ProcessEnv;
  root: string;
  startupTimeoutMs: number;
}): Promise<{ endpoint: string; child: ChildProcess }> {
  const executable = resolvePenguinExecutable(
    {
      ...(options.command ? { command: options.command } : {}),
      environment: options.environment,
    },
    { homeDirectory: os.homedir() },
  );
  const configuredPort = Number.parseInt(options.environment.CODEXHOST_PENGUIN_PORT ?? "", 10);
  const port = Number.isSafeInteger(configuredPort) && configuredPort > 0 ? configuredPort : 0;
  const invocation = commandInvocation(
    executable,
    ["server", "--host", "127.0.0.1", "--port", String(port || DEFAULT_PENGUIN_PORT)],
    options.environment,
  );
  let child: ChildProcess;
  try {
    child = spawn(invocation.command, invocation.arguments, {
      env: spawnEnvironment(options.environment, options.root),
      stdio: ["ignore", "ignore", "pipe"],
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
  } catch (error) {
    throw new PenguinConnectionError("notInstalled", "Penguin executable could not be started", {
      cause: error,
    });
  }
  child.stderr?.resume();
  child.once("error", () => undefined);
  try {
    const lock = await waitForLock(options.root, child, options.startupTimeoutMs);
    return { endpoint: endpointFromLock(lock), child };
  } catch (error) {
    child.kill();
    throw error;
  }
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === "AbortError";
}

function parseSseFrame(lines: string[]): PenguinSseFrame | null {
  let id: string | undefined;
  let event: string | undefined;
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /u, "");
    if (field === "id") id = value;
    else if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0 && event === undefined && id === undefined) return null;
  return {
    ...(id !== undefined ? { id } : {}),
    ...(event !== undefined ? { event } : {}),
    data: data.join("\n"),
  };
}

async function* parseSseBody(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<PenguinSseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let frameLines: string[] = [];
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line === "") {
          const frame = parseSseFrame(frameLines);
          frameLines = [];
          if (frame) yield frame;
        } else {
          frameLines.push(line);
        }
      }
      if (signal?.aborted) return;
    }
    buffer += decoder.decode();
    if (buffer.length > 0) frameLines.push(buffer);
    const frame = parseSseFrame(frameLines);
    if (frame) yield frame;
  } catch (error) {
    if (!isAbortError(error)) throw error;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

class FetchPenguinApiClient implements PenguinApiClient {
  constructor(
    private readonly endpoint: string,
    private token: string,
    private readonly fetchImpl: typeof fetch,
    private readonly localTokenRoot?: string,
  ) {}

  async #fetchAuthed(url: URL, init: RequestInit): Promise<Response> {
    const response = await this.fetchImpl(url, init);
    if (response.status !== 401 || !this.localTokenRoot) return response;
    const freshToken = await readLocalApiToken(this.localTokenRoot);
    if (!freshToken || freshToken === this.token) return response;
    await response.body?.cancel();
    this.token = freshToken;
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.token}`);
    return this.fetchImpl(url, { ...init, headers });
  }

  async request<T>(apiPath: string, options: PenguinRequestOptions = {}): Promise<T> {
    const response = await this.#fetchAuthed(new URL(apiPath, `${this.endpoint}/`), {
      method: options.method ?? "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.token}`,
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) {
      let apiCode = "http_error";
      let message = `Penguin API returned HTTP ${response.status}`;
      try {
        const body: unknown = await response.json();
        if (isRecord(body) && isRecord(body.error)) {
          if (typeof body.error.code === "string") apiCode = body.error.code;
          if (typeof body.error.message === "string" && body.error.message.trim()) {
            message = body.error.message;
          }
        }
      } catch {
        // Preserve the bounded generic error when the server did not return JSON.
      }
      throw new PenguinApiError(response.status, apiCode, message);
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return text.trim().length === 0 ? (undefined as T) : (JSON.parse(text) as T);
  }

  stream(
    sessionId: string,
    signal?: AbortSignal,
    lastEventId?: string,
  ): AsyncIterable<PenguinSseFrame> {
    return this.#stream(sessionId, signal, lastEventId);
  }

  async *#stream(
    sessionId: string,
    signal?: AbortSignal,
    lastEventId?: string,
  ): AsyncGenerator<PenguinSseFrame> {
    let response: Response;
    try {
      response = await this.#fetchAuthed(
        new URL(`/api/sessions/${encodeURIComponent(sessionId)}/stream`, `${this.endpoint}/`),
        {
          headers: {
            accept: "text/event-stream",
            authorization: `Bearer ${this.token}`,
            ...(lastEventId !== undefined ? { "last-event-id": lastEventId } : {}),
          },
          ...(signal ? { signal } : {}),
        },
      );
    } catch (error) {
      if (isAbortError(error)) return;
      throw error;
    }
    if (!response.ok || response.body === null) {
      throw new PenguinApiError(
        response.status,
        "stream_error",
        "Penguin session stream is unavailable",
      );
    }
    yield* parseSseBody(response.body, signal);
  }
}

async function endpointResponds(endpoint: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(new URL("/api/projects", `${endpoint}/`), {
      method: "GET",
      signal: AbortSignal.timeout(1_500),
    });
    await response.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

export async function openPenguinConnection(
  options: PenguinConnectionOptions = {},
): Promise<PenguinConnection> {
  const environment = options.environment ?? process.env;
  const root = dataRoot(environment, options.root);
  const fetchImpl = options.fetchImpl ?? fetch;
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  const explicitEndpoint =
    nonBlank(options.endpoint) ??
    nonBlank(environment.CODEXHOST_PENGUIN_ENDPOINT) ??
    nonBlank(environment.PENGUIN_API_URL);
  let endpoint: string | undefined = explicitEndpoint
    ? normalizeEndpoint(explicitEndpoint)
    : undefined;
  let child: ChildProcess | undefined;
  if (endpoint === undefined) {
    const lock = await readServerLock(root);
    if (lock) endpoint = endpointFromLock(lock);
  }
  if (endpoint === undefined) {
    if (options.autoStartServer === false) {
      throw new PenguinConnectionError("unavailable", "Penguin server is not running");
    }
    const started = await startServer({
      ...(options.command ? { command: options.command } : {}),
      environment,
      root,
      startupTimeoutMs,
    });
    endpoint = started.endpoint;
    child = started.child;
  }
  const loopback = isLoopbackEndpoint(endpoint);
  if (!loopback && !nonBlank(environment.PENGUIN_API_TOKEN)) {
    await Promise.resolve(child?.kill()).catch(() => undefined);
    throw new PenguinConnectionError(
      "authenticationRequired",
      "Remote Penguin servers require PENGUIN_API_TOKEN",
    );
  }
  if (!(await endpointResponds(endpoint, fetchImpl))) {
    await Promise.resolve(child?.kill()).catch(() => undefined);
    throw new PenguinConnectionError("unavailable", "Penguin API endpoint did not respond");
  }
  let token = nonBlank(environment.PENGUIN_API_TOKEN);
  let localTokenRoot: string | undefined;
  if (!token && loopback) {
    token = await readLocalApiToken(root);
    if (token) localTokenRoot = root;
  }
  if (!token) {
    await Promise.resolve(child?.kill()).catch(() => undefined);
    throw new PenguinConnectionError(
      "authenticationRequired",
      loopback
        ? "Penguin local API token is unavailable; start the server with the same data root"
        : "Remote Penguin servers require PENGUIN_API_TOKEN",
    );
  }
  const client = new FetchPenguinApiClient(endpoint, token, fetchImpl, localTokenRoot);
  return {
    endpoint,
    client,
    async close(): Promise<void> {
      if (!child) return;
      const process = child;
      child = undefined;
      if (process.exitCode !== null || process.signalCode !== null) return;
      process.kill();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, closeTimeoutMs);
        process.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}
