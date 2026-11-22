import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable, type Writable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { once } from "node:events";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JSONRPCMessage, RequestId } from "@modelcontextprotocol/sdk/types.js";
import type { JsonObject } from "@codexhost/protocol-core";
import { readLfFrames } from "@codexhost/protocol-core";
import {
  DesktopMcpConfigTransform,
  desktopStdioConfig,
  desktopNativeMcpOverrides,
} from "./desktop-mcp-config.js";
import { jsonBody } from "./delegation-control-server.js";
import { OfficialProcessLifecycle } from "./official-process-lifecycle.js";
import {
  DESKTOP_BROWSER_ACCESS_ENV,
  DESKTOP_BROWSER_MCP_ARGUMENTS_ENV,
} from "./desktop-context-environment.js";

const MAX_MCP_REQUEST_BYTES = 16 * 1024 * 1024;
// A live client keeps its standalone SSE stream open and reconnects it within seconds.
const DETACHED_SESSION_TIMEOUT_MS = 30_000;

interface Profile {
  id: string;
  token: string;
  runtimePath: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  sessions: Map<string, DesktopMcpSession>;
}

/** One genuine stdio tool process for each standard MCP HTTP session. */
class DesktopMcpSession {
  readonly http: WebStandardStreamableHTTPServerTransport;
  readonly #stdio: StdioClientTransport;
  readonly #closed = Promise.withResolvers<undefined>();
  readonly #pending = new Set<RequestId>();
  readonly #queued: JSONRPCMessage[] = [];
  #outgoing = Promise.resolve();
  #standaloneReady = false;
  #closing?: Promise<void>;
  #starting?: Promise<void>;
  readonly #detachedTimeoutMs: number;
  #connections = 0;
  #detached?: NodeJS.Timeout;

  constructor(profile: Profile, remove: () => void, detachedTimeoutMs: number) {
    this.#detachedTimeoutMs = detachedTimeoutMs;
    this.#stdio = new StdioClientTransport({
      command: process.execPath,
      args: [
        profile.runtimePath,
        "--codexhost-desktop-mcp-server",
        profile.command,
        ...profile.args,
      ],
      env: profile.env,
      ...(profile.cwd === undefined ? {} : { cwd: profile.cwd }),
      stderr: "pipe",
      maxBufferSize: Number.MAX_SAFE_INTEGER,
    });
    this.http = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (id) => {
        profile.sessions.set(id, this);
      },
      onsessionclosed: () => this.close(),
    });
    this.http.onmessage = (message) => {
      if ("method" in message && "id" in message) this.#pending.add(message.id);
      if ("method" in message && message.method === "notifications/cancelled") {
        const id = message.params?.requestId;
        if (typeof id === "string" || typeof id === "number") this.#pending.delete(id);
      }
      void this.#flush()
        .then(() => this.#stdio.send(message))
        .catch(() => this.close().catch(() => undefined));
    };
    this.#stdio.onmessage = (message) => {
      this.#outgoing = this.#outgoing
        .then(() => this.#forward(message))
        .catch(() => this.close().catch(() => undefined));
    };
    this.#stdio.onclose = () => {
      this.#closed.resolve(undefined);
      if (this.http.sessionId) profile.sessions.delete(this.http.sessionId);
      remove();
      void this.http.close();
    };
    this.http.onclose = () => {
      void this.close().catch(() => undefined);
    };
    this.#stdio.stderr?.on("data", () => {});
    this.#stdio.onerror = () => {
      void this.close().catch(() => undefined);
    };
  }

  start(): Promise<void> {
    this.#starting ??= (async () => {
      try {
        await this.http.start();
        await this.#stdio.start();
      } catch (error) {
        this.#closed.resolve(undefined);
        void this.close().catch(() => undefined);
        throw error;
      }
    })();
    return this.#starting;
  }

  /**
   * Counts one open HTTP exchange; the returned release ends it. A session left without any
   * exchange (no standalone stream, no request in flight) past the timeout is abandoned, as a
   * killed client never sends DELETE.
   */
  attach(): () => void {
    this.#connections += 1;
    clearTimeout(this.#detached);
    let attached = true;
    return () => {
      if (!attached) return;
      attached = false;
      this.#connections -= 1;
      if (this.#connections > 0 || this.#closing) return;
      this.#detached = setTimeout(() => {
        void this.close().catch(() => undefined);
      }, this.#detachedTimeoutMs).unref();
    };
  }

  async handle(request: Request, body?: unknown): Promise<Response> {
    const response = await this.http.handleRequest(request, { parsedBody: body });
    if (request.method === "GET" && response.status === 200) {
      this.#standaloneReady = true;
      request.signal.addEventListener(
        "abort",
        () => {
          this.#standaloneReady = false;
        },
        { once: true },
      );
      await this.#flush();
    }
    return response;
  }

  async #forward(message: JSONRPCMessage): Promise<void> {
    if (!("method" in message)) {
      await this.http.send(message);
      if (message.id !== undefined) this.#pending.delete(message.id);
      await this.#flush();
      return;
    }
    if (!this.#standaloneReady && this.#pending.size !== 1) {
      this.#queued.push(message);
      return;
    }
    const relatedRequestId =
      !this.#standaloneReady && this.#pending.size === 1
        ? this.#pending.values().next().value
        : undefined;
    await this.http.send(
      message,
      relatedRequestId === undefined ? undefined : { relatedRequestId },
    );
  }

  async #flush(): Promise<void> {
    while (this.#queued.length && (this.#standaloneReady || this.#pending.size === 1)) {
      const message = this.#queued.shift();
      if (message) await this.#forward(message);
    }
  }

  close(): Promise<void> {
    clearTimeout(this.#detached);
    this.#closing ??= Promise.resolve().then(async () => {
      await this.#starting?.catch(() => undefined);
      await this.http.close();
      await this.#stdio.close();
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Desktop MCP tool host exit could not be confirmed")),
          2_000,
        );
        void this.#closed.promise.then(() => {
          clearTimeout(timeout);
          resolve();
        });
      });
    });
    return this.#closing;
  }
}

export interface DesktopMcpBridge {
  input: DesktopMcpConfigTransform;
  environment: Record<string, string>;
  close(): Promise<void>;
}

/** Hosts only Desktop-selected first-party browser MCP processes inside its tree. */
export async function createDesktopMcpBridge(options: {
  nodeReplPath: string;
  runtimePath: string;
  environment: NodeJS.ProcessEnv;
  native?: { executable: string; arguments: readonly string[] };
  detachedSessionTimeoutMs?: number;
}): Promise<DesktopMcpBridge | undefined> {
  let executable: string;
  try {
    executable = realpathSync(options.nodeReplPath);
  } catch {
    return undefined;
  }
  const profiles = new Map<string, Profile>();
  const configurations = new Map<string, Profile>();
  const sessions = new Set<DesktopMcpSession>();
  let closing: Promise<void> | undefined;
  let address = "";

  function register(config: JsonObject, threadCwd?: string): JsonObject | undefined {
    const parsed = desktopStdioConfig.safeParse(config);
    if (!parsed.success) return;
    const definition = parsed.data;
    try {
      const wrapper =
        definition.command === "/bin/sh" &&
        definition.args.length === 4 &&
        definition.args[0] === "-c" &&
        definition.args[1] ===
          'export BROWSER_USE_ACCESS_EXECUTOR_ID="${BROWSER_USE_ACCESS_EXECUTOR_ID-}"; exec "$@"' &&
        definition.args[2] === "cua-repl";
      const target = wrapper ? definition.args[3] : definition.command;
      if (target === undefined || realpathSync(target) !== executable) return;
    } catch {
      return;
    }
    const { args, env: overrides, env_vars: inherited } = definition;
    let services: unknown;
    try {
      services = JSON.parse(String(overrides.NODE_REPL_TRUSTED_SERVICES ?? "{}"));
    } catch {
      return;
    }
    if (typeof services !== "object" || services === null || !("browser" in services)) return;
    const env = { ...getDefaultEnvironment() };
    for (const key of Object.keys(env)) {
      const value = options.environment[key];
      if (value !== undefined) env[key] = value;
    }
    for (const name of [...DESKTOP_BROWSER_ACCESS_ENV, ...inherited]) {
      const value = options.environment[name];
      if (value !== undefined) env[name] = value;
    }
    const childEnv = { ...env, ...overrides };
    const cwd = definition.cwd ?? threadCwd;
    const signature = createHash("sha256")
      .update(JSON.stringify([config.command, args, childEnv, cwd]))
      .digest("hex");
    let profile = configurations.get(signature);
    if (!profile) {
      profile = {
        id: randomUUID(),
        token: randomBytes(32).toString("base64url"),
        runtimePath: options.runtimePath,
        command: definition.command,
        args,
        env: childEnv,
        ...(cwd === undefined ? {} : { cwd }),
        sessions: new Map(),
      };
      profiles.set(profile.id, profile);
      configurations.set(signature, profile);
    }
    return {
      ...config,
      command: process.execPath,
      args: [
        options.runtimePath,
        "--codexhost-desktop-mcp-client",
        `${address}/${profile.id}`,
        `Bearer ${profile.token}`,
      ],
    };
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (closing) {
      response.writeHead(503).end();
      return;
    }
    if (request.headers.host !== new URL(address).host || request.headers.origin !== undefined) {
      response.writeHead(403).end();
      return;
    }
    const profile = profiles.get(new URL(request.url ?? "/", address).pathname.slice(1));
    if (!profile) {
      response.writeHead(404).end();
      return;
    }
    const expected = Buffer.from(`Bearer ${profile.token}`);
    const supplied = Buffer.from(
      typeof request.headers.authorization === "string" ? request.headers.authorization : "",
    );
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      response.writeHead(401, { "www-authenticate": "Bearer" }).end();
      return;
    }
    const id = request.headers["mcp-session-id"];
    let session = typeof id === "string" ? profile.sessions.get(id) : undefined;
    if (session) response.once("close", session.attach());
    let body: Record<string, unknown> | undefined;
    if (request.method === "POST") {
      try {
        body = await jsonBody(request, MAX_MCP_REQUEST_BYTES);
      } catch {
        response.writeHead(400).end();
        return;
      }
    }
    const initializing = session === undefined;
    const controller = new AbortController();
    response.once("close", () => {
      if (!response.writableEnded) {
        controller.abort();
        if (initializing) void session?.close().catch(() => undefined);
      }
    });
    if (response.destroyed) return;
    if (!session) {
      if (id !== undefined || request.method !== "POST" || body?.method !== "initialize") {
        response.writeHead(id === undefined ? 400 : 404).end();
        return;
      }
      const created = new DesktopMcpSession(
        profile,
        () => {
          sessions.delete(created);
        },
        options.detachedSessionTimeoutMs ?? DETACHED_SESSION_TIMEOUT_MS,
      );
      sessions.add(created);
      session = created;
      response.once("close", session.attach());
    }
    if (initializing) await session.start();
    if (controller.signal.aborted) {
      if (initializing) await session.close();
      return;
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (Array.isArray(value)) value.forEach((part) => headers.append(key, part));
      else if (value !== undefined) headers.set(key, value);
    }
    const result = await session.handle(
      new Request(new URL(request.url ?? "/", address), {
        method: request.method ?? "GET",
        headers,
        signal: controller.signal,
      }),
      body,
    );
    if (initializing && result.status >= 400) await session.close();
    response.writeHead(result.status, Object.fromEntries(result.headers));
    if (!result.body) {
      response.end();
      return;
    }
    const readable = Readable.fromWeb(result.body as unknown as NodeReadableStream<Uint8Array>);
    response.once("close", () => {
      readable.destroy();
    });
    readable.on("error", () => {
      response.destroy();
    });
    readable.pipe(response);
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (response.destroyed) return;
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const bound = server.address();
  if (bound === null || typeof bound === "string")
    throw new Error("Desktop MCP listener has no address");
  address = `http://127.0.0.1:${bound.port}`;
  const overrides = await desktopNativeMcpOverrides(options.native, options.environment, register);
  return {
    input: new DesktopMcpConfigTransform(register),
    environment: overrides.length
      ? { [DESKTOP_BROWSER_MCP_ARGUMENTS_ENV]: JSON.stringify(overrides) }
      : {},
    close() {
      closing ??= Promise.resolve().then(async () => {
        const closed = new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        });
        server.closeAllConnections();
        await Promise.all([...sessions].map((session) => session.close()));
        await closed;
      });
      return closing;
    },
  };
}

/** Preserves the native stdio contract while its genuine tool process is owned by Desktop. */
export async function runDesktopMcpClient(
  arguments_: string[],
  streams: { input: Readable; output: Writable } = {
    input: process.stdin,
    output: process.stdout,
  },
): Promise<number> {
  const [url, authorization] = arguments_;
  if (!url || !authorization) throw new Error("Desktop MCP connection is unavailable");
  const http = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: authorization } },
  });
  const input = Readable.from(
    (async function* () {
      for await (const frame of readLfFrames(streams.input, {
        maxFrameBytes: MAX_MCP_REQUEST_BYTES + 1,
      })) {
        const body = frame.at(-1) === 0x0d ? frame.subarray(0, -1) : frame;
        if (body.length > MAX_MCP_REQUEST_BYTES)
          throw new Error("Desktop MCP request exceeds its limit");
        yield Buffer.concat([body, Buffer.from("\n")]);
      }
    })(),
    // Deliver each bounded frame separately to the SDK's aggregate read buffer.
    { objectMode: true, highWaterMark: 1 },
  );
  const stdio = new StdioServerTransport(input, streams.output, {
    maxBufferSize: MAX_MCP_REQUEST_BYTES + 1,
  });
  const done = Promise.withResolvers<number>();
  const failed = () => done.resolve(1);
  input.on("error", failed);
  http.onmessage = (message) => {
    void stdio.send(message).catch(failed);
  };
  stdio.onmessage = (message) => {
    void http.send(message).catch(failed);
  };
  http.onclose = () => done.resolve(0);
  stdio.onclose = () => done.resolve(0);
  http.onerror = failed;
  stdio.onerror = failed;
  const inputClosed = () => done.resolve(0);
  input.once("end", inputClosed);
  input.once("close", inputClosed);
  if (input.readableEnded || input.destroyed) inputClosed();
  try {
    await http.start();
    await stdio.start();
    return await done.promise;
  } finally {
    input.off("end", inputClosed);
    input.off("close", inputClosed);
    await http.terminateSession().catch(() => undefined);
    await http.close();
    input.destroy();
    streams.input.destroy();
    await stdio.close();
  }
}

/** Keeps the tool's peer, parent and grandparent on genuine signed Desktop runtimes. */
export async function runDesktopMcpServer(arguments_: string[]): Promise<number> {
  const [command, ...args] = arguments_;
  if (!command) throw new Error("Desktop MCP executable is unavailable");
  const child = spawn(command, args, { stdio: "pipe", windowsHide: true });
  const lifecycle = new OfficialProcessLifecycle(child, {
    // Finish cleanup inside the MCP SDK's tool-host shutdown grace period.
    timeoutMs: 500,
    endInput: () => child.stdin.end(),
  });
  const done = Promise.withResolvers<number>();
  void lifecycle.closed.then(({ code }) => done.resolve(code ?? 1));
  const stop = () => {
    void lifecycle.stop().catch(done.reject);
  };
  const interrupt = () => {
    child.kill("SIGINT");
    stop();
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", stop);
  process.stdin.once("end", stop);
  process.stdin.once("close", stop);
  child.stdin.on("error", stop);
  child.stdout.on("error", stop);
  child.stderr.on("error", stop);
  process.stdin.on("error", stop);
  process.stdout.on("error", stop);
  process.stderr.on("error", stop);
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });
  if (process.stdin.readableEnded || process.stdin.destroyed) stop();
  try {
    return await done.promise;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", stop);
    process.stdin.off("end", stop);
    process.stdin.off("close", stop);
    process.stdin.off("error", stop);
    process.stdout.off("error", stop);
    process.stderr.off("error", stop);
    process.stdin.unpipe(child.stdin);
    process.stdin.pause();
    child.stdin.destroy();
    // The output pipes drain buffered responses before the tool host exits.
  }
}
