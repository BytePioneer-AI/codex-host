export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

export interface CdpBrowserVersion {
  browser: string;
  protocolVersion: string;
  webSocketDebuggerUrl: string;
}

export interface CdpFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type CdpFetch = (url: string) => Promise<CdpFetchResponse>;

interface CdpSocketEvent {
  data?: unknown;
}

interface CdpSocket {
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: CdpSocketEvent) => void,
  ): void;
  removeEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: CdpSocketEvent) => void,
  ): void;
  send(data: string): void;
  close(): void;
}

export type CdpSocketFactory = (url: string) => CdpSocket;

export interface CdpClientOptions {
  commandTimeoutMs?: number;
  connectTimeoutMs?: number;
  socketFactory?: CdpSocketFactory;
}

export type CdpEventListener = (params: unknown, sessionId: string | undefined) => void;

interface PendingCommand {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

interface CdpResponse {
  id: number;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`CDP target '${field}' must be non-empty text`);
  }
  return value;
}

function loopbackUrl(value: string, protocols: readonly string[]): URL {
  const url = new URL(value);
  if (!protocols.includes(url.protocol)) {
    throw new Error(`CDP endpoint must use ${protocols.join(" or ")}`);
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("CDP endpoint must use a loopback host");
  }
  return url;
}

function parseTarget(value: unknown): CdpTarget {
  if (!isRecord(value)) throw new Error("CDP target must be an object");
  const target = {
    id: nonEmptyString(value.id, "id"),
    type: nonEmptyString(value.type, "type"),
    title: typeof value.title === "string" ? value.title : "",
    url: nonEmptyString(value.url, "url"),
    webSocketDebuggerUrl: nonEmptyString(value.webSocketDebuggerUrl, "webSocketDebuggerUrl"),
  };
  loopbackUrl(target.webSocketDebuggerUrl, ["ws:", "wss:"]);
  return target;
}

function defaultFetch(url: string): Promise<CdpFetchResponse> {
  return fetch(url);
}

function defaultSocketFactory(url: string): CdpSocket {
  return new WebSocket(url) as unknown as CdpSocket;
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  if (ArrayBuffer.isView(value)) {
    return new TextDecoder().decode(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
  }
  throw new Error("CDP WebSocket returned a non-text message");
}

function parseResponse(value: unknown): CdpResponse | null {
  if (!isRecord(value) || typeof value.id !== "number") return null;
  const response: CdpResponse = { id: value.id };
  if ("result" in value) response.result = value.result;
  if (isRecord(value.error)) {
    response.error = {
      ...(typeof value.error.code === "number" ? { code: value.error.code } : {}),
      ...(typeof value.error.message === "string" ? { message: value.error.message } : {}),
    };
  }
  return response;
}

export async function getCdpBrowserVersion(
  endpoint: string,
  fetchImpl: CdpFetch = defaultFetch,
): Promise<CdpBrowserVersion> {
  const baseUrl = loopbackUrl(endpoint, ["http:", "https:"]);
  const response = await fetchImpl(new URL("/json/version", baseUrl).toString());
  if (!response.ok) throw new Error(`CDP version discovery failed with HTTP ${response.status}`);
  const value = await response.json();
  if (!isRecord(value)) throw new Error("CDP version discovery did not return an object");
  const version = {
    browser: nonEmptyString(value.Browser, "Browser"),
    protocolVersion: nonEmptyString(value["Protocol-Version"], "Protocol-Version"),
    webSocketDebuggerUrl: nonEmptyString(value.webSocketDebuggerUrl, "webSocketDebuggerUrl"),
  };
  loopbackUrl(version.webSocketDebuggerUrl, ["ws:", "wss:"]);
  return version;
}

export async function listCdpTargets(
  endpoint: string,
  fetchImpl: CdpFetch = defaultFetch,
): Promise<CdpTarget[]> {
  const baseUrl = loopbackUrl(endpoint, ["http:", "https:"]);
  const targetsUrl = new URL("/json/list", baseUrl).toString();
  const response = await fetchImpl(targetsUrl);
  if (!response.ok) throw new Error(`CDP target discovery failed with HTTP ${response.status}`);
  const value = await response.json();
  if (!Array.isArray(value)) throw new Error("CDP target discovery did not return an array");
  return value.map(parseTarget);
}

export async function waitForRendererTarget(
  endpoint: string,
  options: {
    fetchImpl?: CdpFetch;
    pollIntervalMs?: number;
    timeoutMs?: number;
  } = {},
): Promise<CdpTarget> {
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const targets = await listCdpTargets(endpoint, fetchImpl);
      const renderer = targets.find(
        (target) => target.type === "page" && target.url.startsWith("app://"),
      );
      if (renderer) return renderer;
      lastError = new Error("CDP has no app:// page target");
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`Codex Renderer CDP target did not become ready${detail}`);
}

export class CdpClient {
  readonly #commandTimeoutMs: number;
  readonly #socket: CdpSocket;
  #closed = false;
  #nextId = 1;
  #pending = new Map<number, PendingCommand>();
  #listeners = new Map<string, Set<CdpEventListener>>();

  private constructor(socket: CdpSocket, commandTimeoutMs: number) {
    this.#socket = socket;
    this.#commandTimeoutMs = commandTimeoutMs;
    socket.addEventListener("message", (event) => this.#onMessage(event));
    socket.addEventListener("error", () => this.#fail(new Error("CDP WebSocket failed")));
    socket.addEventListener("close", () => this.#fail(new Error("CDP WebSocket closed")));
  }

  static async connect(url: string, options: CdpClientOptions = {}): Promise<CdpClient> {
    loopbackUrl(url, ["ws:", "wss:"]);
    const socketFactory = options.socketFactory ?? defaultSocketFactory;
    const socket = socketFactory(url);
    const connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        socket.close();
        reject(new Error("CDP WebSocket connection timed out"));
      }, connectTimeoutMs);
      const onOpen = (): void => {
        cleanup();
        resolve();
      };
      const onError = (): void => {
        cleanup();
        reject(new Error("CDP WebSocket connection failed"));
      };
      const cleanup = (): void => {
        clearTimeout(timeout);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
      };
      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
    });
    return new CdpClient(socket, options.commandTimeoutMs ?? 10_000);
  }

  command(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.#send(method, params);
  }

  sessionCommand(
    sessionId: string,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (sessionId.length === 0) return Promise.reject(new Error("CDP session ID is required"));
    return this.#send(method, params, sessionId);
  }

  on(method: string, listener: CdpEventListener): () => void {
    const listeners = this.#listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(method, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(method);
    };
  }

  #send(method: string, params: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("CDP client is closed"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP command '${method}' timed out`));
      }, this.#commandTimeoutMs);
      this.#pending.set(id, { resolve, reject, timeout });
      try {
        this.#socket.send(
          JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }),
        );
      } catch (error) {
        clearTimeout(timeout);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const response = await this.command("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (!isRecord(response)) throw new Error("Runtime.evaluate returned an invalid result");
    if (isRecord(response.exceptionDetails)) {
      const text =
        typeof response.exceptionDetails.text === "string"
          ? response.exceptionDetails.text
          : "Renderer evaluation failed";
      throw new Error(text);
    }
    if (!isRecord(response.result) || !("value" in response.result)) {
      throw new Error("Runtime.evaluate did not return a value");
    }
    return response.result.value as T;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#fail(new Error("CDP client closed"));
    this.#listeners.clear();
    this.#socket.close();
  }

  #onMessage(event: CdpSocketEvent): void {
    try {
      const value: unknown = JSON.parse(messageText(event.data));
      const response = parseResponse(value);
      if (!response) {
        if (!isRecord(value) || typeof value.method !== "string") return;
        const sessionId = typeof value.sessionId === "string" ? value.sessionId : undefined;
        for (const listener of this.#listeners.get(value.method) ?? []) {
          listener(value.params, sessionId);
        }
        return;
      }
      const pending = this.#pending.get(response.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.#pending.delete(response.id);
      if (response.error) {
        const code = response.error.code === undefined ? "unknown" : String(response.error.code);
        pending.reject(
          new Error(response.error.message ?? `CDP command failed with error ${code}`),
        );
      } else {
        pending.resolve(response.result);
      }
    } catch (error) {
      this.#fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #fail(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
