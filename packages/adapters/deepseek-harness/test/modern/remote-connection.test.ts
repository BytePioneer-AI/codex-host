import type { ChildProcess } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import {
  ModernRemoteConnection,
  type ModernRemoteConnectionDependencies,
  type ModernWebSocket,
} from "../../src/modern/remote-connection.js";
import {
  assertModernStreamEndpoint,
  assertModernUnaryEndpoint,
  parseLaunchUrl,
  parseSessionCookie,
  redactModernCredential,
} from "../../src/modern/wire.js";

const TOKEN = "A".repeat(43);
const AUTHORITY = "127.0.0.1:4567";
const COOKIE_NAME = `dsh-auth-${createHash("sha256").update(AUTHORITY).digest("base64url")}`;
const COOKIE_SECRET = Buffer.alloc(32, 7);
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const COOKIE_ISSUED_AT = Date.now() - 1_000;

function sessionCookie(
  authority: string,
  options: {
    readonly issuedAt?: number;
    readonly expiresAt?: number;
    readonly payloadAuthority?: string;
  } = {},
): { readonly cookie: string; readonly setCookie: string } {
  const issuedAt = options.issuedAt ?? COOKIE_ISSUED_AT;
  const expiresAt = options.expiresAt ?? issuedAt + COOKIE_MAX_AGE_SECONDS * 1_000;
  const body = Buffer.from(
    JSON.stringify({
      version: 1,
      authority: options.payloadAuthority ?? authority,
      issuedAt,
      expiresAt,
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", COOKIE_SECRET).update(body).digest("base64url");
  const name = `dsh-auth-${createHash("sha256").update(authority).digest("base64url")}`;
  const cookie = `${name}=v1.${body}.${signature}`;
  return {
    cookie,
    setCookie: `${cookie}; Max-Age=${String(COOKIE_MAX_AGE_SECONDS)}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; SameSite=Strict`,
  };
}

const { cookie: COOKIE, setCookie: SET_COOKIE } = sessionCookie(AUTHORITY);

interface FakeChild extends ChildProcess {
  stdout: PassThrough;
  stderr: PassThrough;
}

function fakeChild(options: { exitOnTerm?: boolean } = {}): FakeChild {
  const child = new EventEmitter() as FakeChild;
  Object.assign(child, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: null,
    stdio: [],
    exitCode: null,
    signalCode: null,
    killed: false,
    kill: vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
      Object.assign(child, { killed: true });
      if (options.exitOnTerm !== false) {
        queueMicrotask(() => {
          Object.assign(child, { signalCode: signal });
          child.emit("exit", null, signal);
        });
      }
      return true;
    }),
  });
  return child;
}

class FakeWebSocket extends EventEmitter implements ModernWebSocket {
  readyState = 0;
  readonly sent: Array<Record<string, unknown>> = [];

  constructor(
    readonly onSend?: (message: Record<string, unknown>) => void,
    readonly acknowledgeClose = true,
  ) {
    super();
  }

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  server(message: object, streamId?: string): void {
    const value = streamId === undefined ? message : { ...message, streamId };
    this.serverRaw(JSON.stringify(value));
  }

  serverRaw(text: string): void {
    this.emit("message", Buffer.from(text), false);
  }

  send(text: string): void {
    const message = JSON.parse(text) as Record<string, unknown>;
    this.sent.push(message);
    this.onSend?.(message);
  }

  close(): void {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    if (!this.acknowledgeClose) return;
    queueMicrotask(() => {
      this.readyState = 3;
      this.emit("close");
    });
  }

  terminate(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.emit("close"));
  }
}

function authResponse(authority = AUTHORITY): Response {
  const fixture = sessionCookie(authority);
  return new Response(null, {
    status: 303,
    headers: {
      location: "/",
      "set-cookie": fixture.setCookie,
    },
  });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function blockedJsonResponse(signal: AbortSignal): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const abort = (): void => controller.error(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return address.port;
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

const createNodeWebSocket: ModernRemoteConnectionDependencies["createWebSocket"] = (
  url,
  cookie,
  maxPayload,
) =>
  new WebSocket(url, {
    headers: { Cookie: cookie },
    maxPayload,
  }) as unknown as ModernWebSocket;

function harness(
  fetch: ModernRemoteConnectionDependencies["fetch"],
  options: {
    child?: FakeChild;
    createWebSocket?: ModernRemoteConnectionDependencies["createWebSocket"];
    closeTimeoutMs?: number;
    command?: string;
    commandArguments?: readonly string[];
    platform?: NodeJS.Platform;
    killProcessTree?: ModernRemoteConnectionDependencies["killProcessTree"];
    connectionOptions?: Partial<ConstructorParameters<typeof ModernRemoteConnection>[0]>;
    readiness?: string;
  } = {},
): {
  child: FakeChild;
  connection: ModernRemoteConnection;
  spawn: ReturnType<typeof vi.fn<ModernRemoteConnectionDependencies["spawn"]>>;
  killProcessTree: ReturnType<typeof vi.fn<ModernRemoteConnectionDependencies["killProcessTree"]>>;
} {
  const child = options.child ?? fakeChild();
  const readiness = options.readiness ?? `dsh web: http://127.0.0.1:4567/?token=${TOKEN}`;
  const spawn = vi.fn<ModernRemoteConnectionDependencies["spawn"]>(() => {
    queueMicrotask(() => child.stdout.write(`${readiness}\n`));
    return child;
  });
  const killProcessTree = vi.fn<ModernRemoteConnectionDependencies["killProcessTree"]>(
    options.killProcessTree ?? (() => undefined),
  );
  const dependencies: ModernRemoteConnectionDependencies = {
    spawn,
    fetch,
    createWebSocket:
      options.createWebSocket ??
      (() => {
        throw new Error("unexpected WebSocket");
      }),
    randomUUID: vi.fn(() => "fixture-id"),
    platform: options.platform ?? "linux",
    killProcessTree,
  };
  return {
    child,
    connection: new ModernRemoteConnection(
      {
        command: options.command ?? "dsh",
        commandArguments: options.commandArguments ?? ["--fixture-prefix"],
        startupTimeoutMs: 100,
        unaryTimeoutMs: 100,
        streamOpenTimeoutMs: 100,
        closeTimeoutMs: options.closeTimeoutMs ?? 20,
        ...options.connectionOptions,
      },
      dependencies,
    ),
    spawn,
    killProcessTree,
  };
}

describe("DeepSeek Harness Modern Web Remote connection", () => {
  it("starts managed Web, exchanges the token, and sends an authenticated unary envelope", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetch = vi.fn<ModernRemoteConnectionDependencies["fetch"]>((url, init) => {
      requests.push({ url: url.href, init });
      if (init.method === "GET") return Promise.resolve(authResponse());
      const request = JSON.parse(String(init.body)) as { rpcId: string };
      return Promise.resolve(
        jsonResponse({
          type: "server-response",
          rpcId: request.rpcId,
          result: { ok: true, value: { groups: [] } },
        }),
      );
    });
    const { child, connection, spawn } = harness(fetch);

    await expect(connection.call("session/modelCatalog", {})).resolves.toEqual({
      ok: true,
      value: { groups: [] },
    });
    expect(spawn).toHaveBeenCalledWith(
      "dsh",
      ["--fixture-prefix", "web", "--no-open", "--host", "127.0.0.1", "--port", "0"],
      expect.objectContaining({ stdio: "pipe", windowsHide: true }),
    );
    expect(requests[0]?.url).toBe(`http://127.0.0.1:4567/?token=${TOKEN}`);
    expect(requests[0]?.init).toMatchObject({ method: "GET", redirect: "manual" });
    expect(requests[1]?.url).toBe("http://127.0.0.1:4567/api/session/modelCatalog");
    expect(requests[1]?.init.headers).toEqual({
      "content-type": "application/json",
      cookie: COOKIE,
    });
    expect(JSON.parse(String(requests[1]?.init.body))).toEqual({
      type: "client-request",
      rpcId: "fixture-id",
      method: "session/modelCatalog",
      payload: { args: {} },
    });

    await connection.close();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("opens only the owned loopback Web URL and clears it when the process closes", async () => {
    let release = (): void => undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const openWebUi = vi.fn<(url: URL) => Promise<void>>(() => pending);
    const setup = harness(
      vi.fn(() => Promise.resolve(authResponse())),
      {
        connectionOptions: { openWebUi },
      },
    );
    await setup.connection.connect();

    const first = setup.connection.openWebUi();
    const duplicate = setup.connection.openWebUi();
    expect(first).toBe(duplicate);
    await vi.waitFor(() => expect(openWebUi).toHaveBeenCalledOnce());
    expect(openWebUi.mock.calls[0]?.[0].href).toBe(`http://127.0.0.1:4567/?token=${TOKEN}`);
    release();
    await first;

    await setup.connection.close();
    await expect(setup.connection.openWebUi()).rejects.toMatchObject({ code: "unavailable" });
    expect(openWebUi).toHaveBeenCalledOnce();
  });

  it("redacts the bootstrap token from browser handoff failures", async () => {
    const setup = harness(
      vi.fn(() => Promise.resolve(authResponse())),
      {
        connectionOptions: {
          openWebUi: (url) => Promise.reject(new Error(`failed to open ${url.href}`)),
        },
      },
    );

    await expect(setup.connection.openWebUi()).rejects.toMatchObject({
      code: "unavailable",
      message: expect.not.stringContaining(TOKEN),
    });
    await setup.connection.close();
  });

  it("never follows a unary redirect or forwards its authenticated body", async () => {
    let targetRequests = 0;
    let targetBody = "";
    const target = createServer((request, response) => {
      targetRequests += 1;
      request.on("data", (chunk: Buffer) => {
        targetBody += chunk.toString("utf8");
      });
      request.on("end", () => {
        response.writeHead(204);
        response.end();
      });
    });
    const targetPort = await listen(target);
    let sourceBody = "";
    const source = createServer((request, response) => {
      request.on("data", (chunk: Buffer) => {
        sourceBody += chunk.toString("utf8");
      });
      request.on("end", () => {
        response.writeHead(307, {
          location: `http://127.0.0.1:${String(targetPort)}/stolen`,
        });
        response.end();
      });
    });
    const sourcePort = await listen(source);
    const authority = `127.0.0.1:${String(sourcePort)}`;
    let redirectMode: RequestRedirect | undefined;
    const fetch = vi.fn<ModernRemoteConnectionDependencies["fetch"]>((url, init) => {
      if (init.method === "GET") return Promise.resolve(authResponse(authority));
      redirectMode = init.redirect;
      return globalThis.fetch(url, init);
    });
    const setup = harness(fetch, {
      readiness: `dsh web: http://${authority}/?token=${TOKEN}`,
    });

    try {
      await expect(setup.connection.call("session/list", {})).rejects.toMatchObject({
        code: "protocolError",
      });
      expect(redirectMode).toBe("manual");
      expect(sourceBody).toContain('"type":"client-request"');
      expect(targetRequests).toBe(0);
      expect(targetBody).toBe("");
    } finally {
      await setup.connection.close();
      await closeServer(source);
      await closeServer(target);
    }
  });

  it("rejects an untrusted readiness URL and redacts credentials from diagnostics", async () => {
    const child = fakeChild();
    const { connection } = harness(vi.fn(), {
      child,
      readiness: `dsh web: http://example.com:4567/?token=${TOKEN}`,
    });

    const pending = connection.connect();
    child.stderr.write(`failed near http://127.0.0.1:4567/?token=${TOKEN}\n`);
    const failure = await pending.catch((error: unknown) => error as Error);
    if (!(failure instanceof Error)) throw new Error("expected connection failure");
    expect(failure).toMatchObject({ code: "protocolError" });
    expect(failure.message).not.toContain(TOKEN);
    expect(connection.stderrTail).toContain("token=<redacted>");
    expect(connection.stderrTail).not.toContain(TOKEN);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it.each([
    `dsh web: http://127.0.0.1:4567/?%74oken=${TOKEN}`,
    `dsh web: http://127.0.0.1:4567/%2e/?token=${TOKEN}`,
    `dsh web: HTTP://127.0.0.1:4567/?token=${TOKEN}`,
  ])("rejects a non-canonical readiness URL: %s", (line) => {
    expect(() => parseLaunchUrl(line)).toThrow("not canonical");
  });

  it("continuously retains only a sanitized bounded stderr tail", async () => {
    const child = fakeChild();
    const { connection } = harness(vi.fn(), {
      child,
      readiness: `dsh web: http://example.com:4567/?token=${TOKEN}`,
    });
    const canary = "STDERR_SECRET_CANARY";

    const pending = connection.connect();
    child.stderr.write(`EARLIEST_MARKER\n${"x".repeat(20_000)}`);
    const longSecretFragment = "LONG_STDERR_SECRET_FRAGMENT";
    child.stderr.write(`api_key=${longSecretFragment.repeat(1_000)}`);
    child.stderr.write("\n");
    child.stderr.write("api_key=");
    child.stderr.write(`${canary}\n`);
    child.stderr.write("Bearer STDERR_SPLIT_SECRET_");
    child.stderr.write("FRAGMENT_LEAK\nTAIL_MARKER\n");
    await pending.catch(() => undefined);

    expect(connection.stderrTail.length).toBeLessThanOrEqual(8_000);
    expect(connection.stderrTail).toContain("api_key=[redacted]");
    expect(connection.stderrTail).toContain("Bearer [redacted]");
    expect(connection.stderrTail).toContain("TAIL_MARKER");
    expect(connection.stderrTail).not.toContain(canary);
    expect(connection.stderrTail).not.toContain(longSecretFragment);
    expect(connection.stderrTail).not.toContain("FRAGMENT_LEAK");
    expect(connection.stderrTail).not.toContain("EARLIEST_MARKER");
    expect(child.stderr.readableFlowing).toBe(true);
  });

  it("keeps the sanitized stderr diagnostic after closing", async () => {
    const child = fakeChild();
    const { connection } = harness(
      vi.fn(() => Promise.resolve(authResponse())),
      { child },
    );
    const connecting = connection.connect();
    child.stderr.write(`api_key=${TOKEN}\n`);
    await connecting;
    await connection.close();

    expect(connection.stderrTail).toBe("api_key=[redacted]\n");
    expect(connection.stderrTail).not.toContain(TOKEN);
  });

  it("fails closed on expired authentication and mismatched RPC identities", async () => {
    let mode: "auth" | "rpc" = "auth";
    const fetch = vi.fn<ModernRemoteConnectionDependencies["fetch"]>((_url, init) => {
      if (init.method === "GET") return Promise.resolve(authResponse());
      const request = JSON.parse(String(init.body)) as { rpcId: string };
      return Promise.resolve(
        mode === "auth"
          ? new Response("unauthorized", { status: 401 })
          : jsonResponse({
              type: "server-response",
              rpcId: `${request.rpcId}-wrong`,
              result: { ok: true },
            }),
      );
    });
    const { connection } = harness(fetch);

    await expect(connection.call("session/list", { _request: {} })).rejects.toMatchObject({
      code: "authenticationRequired",
    });
    mode = "rpc";
    await expect(connection.call("session/list", { _request: {} })).rejects.toMatchObject({
      code: "protocolError",
    });
    await connection.close();
  });

  it("carries logical stream items over an authenticated Remote mux", async () => {
    let socket: FakeWebSocket | undefined;
    let websocketUrl: string | undefined;
    let websocketCookie: string | undefined;
    let websocketMaxPayload: number | undefined;
    const createWebSocket: ModernRemoteConnectionDependencies["createWebSocket"] = (
      url,
      cookie,
      maxPayload,
    ) => {
      websocketUrl = url.href;
      websocketCookie = cookie;
      websocketMaxPayload = maxPayload;
      socket = new FakeWebSocket((message) => {
        if (message.type !== "open") return;
        const streamId = String(message.streamId);
        queueMicrotask(() => {
          socket?.server({ type: "item", value: { type: "ready" } }, streamId);
          socket?.server({ type: "end" }, streamId);
        });
      });
      queueMicrotask(() => socket?.open());
      return socket;
    };
    const { connection } = harness(
      vi.fn((_url, init) =>
        Promise.resolve(
          init.method === "GET" ? authResponse() : new Response(null, { status: 500 }),
        ),
      ),
      { createWebSocket },
    );

    const values: unknown[] = [];
    for await (const value of connection.openStream("$events", {})) values.push(value);

    expect(values).toEqual([{ type: "ready" }]);
    expect(websocketUrl).toBe("ws://127.0.0.1:4567/api/remote.mux");
    expect(websocketCookie).toBe(COOKIE);
    expect(websocketMaxPayload).toBe(32 * 1024 * 1024);
    expect(socket?.sent[0]).toEqual({
      type: "open",
      streamId: "fixture-id",
      endpoint: "$events",
      payload: { args: {} },
    });
    await connection.close();
  });

  it("preserves physical open-before-message ordering when both arrive synchronously", async () => {
    let socket: FakeWebSocket | undefined;
    const { connection } = harness(
      vi.fn(() => Promise.resolve(authResponse())),
      {
        createWebSocket: () => {
          socket = new FakeWebSocket();
          queueMicrotask(() => {
            socket?.open();
            socket?.server({ type: "item", value: "first" }, "fixture-id");
            socket?.server({ type: "end" }, "fixture-id");
          });
          return socket;
        },
      },
    );

    const values: unknown[] = [];
    for await (const value of connection.openStream("session/follow", {})) values.push(value);

    expect(values).toEqual(["first"]);
    await connection.close();
  });

  it("rejects a frame emitted after physical open but before the logical open send", async () => {
    let socket: FakeWebSocket | undefined;
    const { connection } = harness(
      vi.fn(() => Promise.resolve(authResponse())),
      {
        createWebSocket: () => {
          socket = new FakeWebSocket();
          socket.on("open", () => {
            socket?.server({ type: "item", value: "early" }, "fixture-id");
          });
          queueMicrotask(() => socket?.open());
          return socket;
        },
      },
    );

    const iterator = connection.openStream("session/follow", {})[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ code: "protocolError" });
    expect(socket?.sent).toEqual([]);
    await connection.close();
  });

  it("reports a synchronous logical open send exception as a transport failure", async () => {
    let socket: FakeWebSocket | undefined;
    const { connection } = harness(
      vi.fn(() => Promise.resolve(authResponse())),
      {
        createWebSocket: () => {
          socket = new FakeWebSocket(() => {
            throw new Error("fixture send failure");
          });
          queueMicrotask(() => socket?.open());
          return socket;
        },
      },
    );

    const iterator = connection.openStream("session/follow", {})[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ code: "unavailable" });
    await connection.close();
  });

  it("rejects logical frames received before the physical WebSocket opens", async () => {
    let socket: FakeWebSocket | undefined;
    const { connection } = harness(
      vi.fn(() => Promise.resolve(authResponse())),
      {
        createWebSocket: () => {
          socket = new FakeWebSocket();
          queueMicrotask(() => socket?.server({ type: "item", value: "early" }, "fixture-id"));
          return socket;
        },
      },
    );

    const iterator = connection.openStream("session/follow", {})[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ code: "protocolError" });
    await connection.close();
  });

  it("rejects duplicate terminal and queued post-terminal frames", async () => {
    for (const trailing of [{ type: "end" }, { type: "item", value: "late" }]) {
      let socket: FakeWebSocket | undefined;
      const setup = harness(
        vi.fn(() => Promise.resolve(authResponse())),
        {
          createWebSocket: () => {
            socket = new FakeWebSocket((message) => {
              if (message.type !== "open") return;
              const streamId = String(message.streamId);
              queueMicrotask(() => {
                socket?.server({ type: "end" }, streamId);
                socket?.server(trailing, streamId);
              });
            });
            queueMicrotask(() => socket?.open());
            return socket;
          },
        },
      );

      const iterator = setup.connection.openStream("session/follow", {})[Symbol.asyncIterator]();
      await expect(iterator.next()).rejects.toMatchObject({ code: "protocolError" });
      await setup.connection.close();
    }
  });

  it("sends logical cancellation when a stream consumer stops early", async () => {
    let socket: FakeWebSocket | undefined;
    const createWebSocket: ModernRemoteConnectionDependencies["createWebSocket"] = () => {
      socket = new FakeWebSocket((message) => {
        if (message.type === "open") {
          queueMicrotask(() =>
            socket?.server({ type: "item", value: "first" }, String(message.streamId)),
          );
        }
      });
      queueMicrotask(() => socket?.open());
      return socket;
    };
    const { connection } = harness(
      vi.fn((_url, init) =>
        Promise.resolve(
          init.method === "GET" ? authResponse() : new Response(null, { status: 500 }),
        ),
      ),
      { createWebSocket },
    );
    const iterator = connection
      .openStream<string>("session/follow", {
        request: { address: { kind: "session", sessionId: "session-1" } },
      })
      [Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({ done: false, value: "first" });
    await iterator.return?.();
    expect(socket?.sent.map(({ type }) => type)).toEqual(["open", "cancel"]);
    expect(socket?.sent[1]?.streamId).toBe(socket?.sent[0]?.streamId);
    await connection.close();
  });

  it("terminates each completed stream whose close handshake exceeds the bound", async () => {
    const sockets: FakeWebSocket[] = [];
    const { connection } = harness(
      vi.fn(() => Promise.resolve(authResponse())),
      {
        connectionOptions: { closeTimeoutMs: 1 },
        createWebSocket: () => {
          const socket = new FakeWebSocket((message) => {
            if (message.type === "open") {
              queueMicrotask(() => socket.server({ type: "end" }, String(message.streamId)));
            }
          }, false);
          vi.spyOn(socket, "terminate");
          sockets.push(socket);
          queueMicrotask(() => socket.open());
          return socket;
        },
      },
    );

    for (let index = 0; index < 3; index += 1) {
      const values: unknown[] = [];
      for await (const value of connection.openStream("session/follow", {})) values.push(value);
      expect(values).toEqual([]);
    }
    expect(sockets).toHaveLength(3);
    for (const socket of sockets) expect(socket.terminate).toHaveBeenCalledOnce();

    await connection.close();
    for (const socket of sockets) expect(socket.terminate).toHaveBeenCalledOnce();
  });

  it("fails closed after a terminated stream misses the second physical-close bound", async () => {
    let socket: FakeWebSocket | undefined;
    const { connection } = harness(
      vi.fn(() => Promise.resolve(authResponse())),
      {
        connectionOptions: { closeTimeoutMs: 1 },
        createWebSocket: () => {
          socket = new FakeWebSocket((message) => {
            if (message.type === "open") {
              queueMicrotask(() => socket?.server({ type: "end" }, String(message.streamId)));
            }
          }, false);
          vi.spyOn(socket, "terminate").mockImplementation(() => {
            if (socket) socket.readyState = 3;
          });
          queueMicrotask(() => socket?.open());
          return socket;
        },
      },
    );

    const consume = async (): Promise<void> => {
      for await (const value of connection.openStream("session/follow", {})) {
        throw new Error(`unexpected stream item ${String(value)}`);
      }
    };
    await expect(consume()).rejects.toMatchObject({ code: "unavailable" });
    expect(socket?.terminate).toHaveBeenCalledOnce();
    expect(socket?.listenerCount("error")).toBe(0);
    expect(socket?.listenerCount("close")).toBe(0);
    await connection.close();
    expect(socket?.terminate).toHaveBeenCalledOnce();
  });

  it("terminates a paused stream before connection close clears socket tracking", async () => {
    let socket: FakeWebSocket | undefined;
    const { connection } = harness(
      vi.fn(() => Promise.resolve(authResponse())),
      {
        createWebSocket: () => {
          socket = new FakeWebSocket((message) => {
            if (message.type === "open") {
              queueMicrotask(() =>
                socket?.server({ type: "item", value: "paused" }, String(message.streamId)),
              );
            }
          }, false);
          vi.spyOn(socket, "terminate").mockImplementation(() => {
            if (!socket || socket.readyState === 3) return;
            socket.readyState = 2;
            queueMicrotask(() => {
              socket?.emit("error", new Error("late close error"));
              if (!socket) return;
              socket.readyState = 3;
              socket.emit("close");
            });
          });
          queueMicrotask(() => socket?.open());
          return socket;
        },
      },
    );
    const iterator = connection.openStream<string>("session/follow", {})[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: "paused" });

    await connection.close();
    expect(socket?.terminate).toHaveBeenCalledOnce();
    expect(socket?.listenerCount("error")).toBe(0);
    await iterator.return?.();
  });

  it("rejects a frame belonging to another logical stream", async () => {
    let socket: FakeWebSocket | undefined;
    const createWebSocket: ModernRemoteConnectionDependencies["createWebSocket"] = () => {
      socket = new FakeWebSocket((message) => {
        if (message.type === "open") {
          queueMicrotask(() => socket?.server({ type: "item", value: "wrong" }, "other-stream"));
        }
      });
      queueMicrotask(() => socket?.open());
      return socket;
    };
    const { connection } = harness(
      vi.fn((_url, init) =>
        Promise.resolve(
          init.method === "GET" ? authResponse() : new Response(null, { status: 500 }),
        ),
      ),
      { createWebSocket },
    );

    const iterator = connection
      .openStream("session/follow", {
        request: { address: { kind: "session", sessionId: "session-1" } },
      })
      [Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ code: "protocolError" });
    await connection.close();
  });

  it("escalates managed-process shutdown after the close bound", async () => {
    const child = fakeChild({ exitOnTerm: false });
    const killProcessTree = vi.fn(() => {
      queueMicrotask(() => {
        Object.assign(child, { signalCode: "SIGKILL" });
        child.emit("exit", null, "SIGKILL");
      });
    });
    const { connection } = harness(
      vi.fn((_url, init) =>
        Promise.resolve(
          init.method === "GET" ? authResponse() : new Response(null, { status: 500 }),
        ),
      ),
      { child, closeTimeoutMs: 1, killProcessTree },
    );

    await connection.connect();
    await connection.close();

    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(killProcessTree).toHaveBeenCalledWith(child, "linux", 1);
  });

  it("forces the owned process tree even after its root exits gracefully", async () => {
    const child = fakeChild();
    const setup = harness(
      vi.fn(() => Promise.resolve(authResponse())),
      { child },
    );

    await setup.connection.connect();
    await setup.connection.close();

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(setup.killProcessTree).toHaveBeenCalledOnce();
  });

  it("rejects close when the managed process survives tree termination", async () => {
    const child = fakeChild({ exitOnTerm: false });
    const { connection, killProcessTree } = harness(
      vi.fn((_url, init) =>
        Promise.resolve(
          init.method === "GET" ? authResponse() : new Response(null, { status: 500 }),
        ),
      ),
      { child, closeTimeoutMs: 1 },
    );

    await connection.connect();
    await expect(connection.close()).rejects.toMatchObject({ code: "unavailable" });
    expect(killProcessTree).toHaveBeenCalledOnce();
  });

  it("builds the complete Windows shim invocation only after appending Web arguments", async () => {
    const environment = { ComSpec: String.raw`C:\Windows\System32\cmd.exe` };
    const command = String.raw`C:\Program Files\100% tools\dsh.cmd`;
    const child = fakeChild({ exitOnTerm: false });
    const killProcessTree = vi.fn(() => {
      queueMicrotask(() => {
        Object.assign(child, { signalCode: "SIGKILL" });
        child.emit("exit", null, "SIGKILL");
      });
    });
    const { connection, spawn } = harness(
      vi.fn((_url, init) =>
        Promise.resolve(
          init.method === "GET" ? authResponse() : new Response(null, { status: 500 }),
        ),
      ),
      {
        child,
        command,
        commandArguments: ["--offline", "--no-install", "@deepseek-ai/dsh"],
        killProcessTree,
        platform: "win32",
        connectionOptions: { environment },
      },
    );

    await connection.connect();
    const [spawnedCommand, spawnedArguments, spawnedOptions] = spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { windowsVerbatimArguments: boolean; detached: boolean },
    ];
    expect(spawnedCommand).toBe(environment.ComSpec);
    expect(spawnedArguments.slice(0, 4)).toEqual(["/d", "/v:off", "/s", "/c"]);
    expect(spawnedArguments.at(-1)).toContain(
      String.raw`"C:\Program Files\100%% tools\dsh.cmd" "--offline" "--no-install" "@deepseek-ai/dsh" "web" "--no-open" "--host" "127.0.0.1" "--port" "0"`,
    );
    expect(spawnedOptions).toMatchObject({ windowsVerbatimArguments: true, detached: false });
    await connection.close();
  });

  it("preserves processExited when a Windows root exits before readiness", async () => {
    const child = fakeChild({ exitOnTerm: false });
    const setup = harness(vi.fn(), {
      child,
      platform: "win32",
      readiness: "",
    });
    const connecting = setup.connection.connect();

    Object.assign(child, { exitCode: 1 });
    child.emit("exit", 1, null);

    await expect(connecting).rejects.toMatchObject({ code: "processExited" });
    expect(setup.killProcessTree).toHaveBeenCalledOnce();
    await expect(setup.connection.close()).resolves.toBeUndefined();
    expect(setup.killProcessTree).toHaveBeenCalledOnce();
  });

  it("does not repeat Windows tree cleanup when closing after a process fault", async () => {
    const child = fakeChild({ exitOnTerm: false });
    const setup = harness(
      vi.fn(() => Promise.resolve(authResponse())),
      {
        child,
        platform: "win32",
      },
    );
    await setup.connection.connect();
    const faulted = vi.fn();
    setup.connection.onFault(faulted);

    Object.assign(child, { exitCode: 1 });
    child.emit("exit", 1, null);

    expect(faulted).toHaveBeenCalledWith(expect.objectContaining({ code: "processExited" }));
    expect(setup.killProcessTree).toHaveBeenCalledOnce();
    await expect(setup.connection.close()).resolves.toBeUndefined();
    expect(setup.killProcessTree).toHaveBeenCalledOnce();
  });

  it("validates the exact authority cookie name and attributes", () => {
    expect(parseSessionCookie(authResponse().headers, AUTHORITY)).toBe(COOKIE);
    const wrongLifetime = sessionCookie(AUTHORITY, {
      expiresAt: COOKIE_ISSUED_AT + (COOKIE_MAX_AGE_SECONDS + 1) * 1_000,
    }).setCookie;
    for (const invalid of [
      SET_COOKIE.replace(COOKIE_NAME, "dsh-auth-wrong"),
      sessionCookie(AUTHORITY, { payloadAuthority: "127.0.0.1:9999" }).setCookie,
      SET_COOKIE.replace(/\.[A-Za-z0-9_-]+;/u, ".short;"),
      wrongLifetime,
      SET_COOKIE.replace(
        `Max-Age=${String(COOKIE_MAX_AGE_SECONDS)}`,
        `Max-Age=${String(COOKIE_MAX_AGE_SECONDS - 1)}`,
      ),
      SET_COOKIE.replace(
        /Expires=[^;]+/u,
        `Expires=${new Date(COOKIE_ISSUED_AT + COOKIE_MAX_AGE_SECONDS * 1_000 + 60_000).toUTCString()}`,
      ),
      `${SET_COOKIE}; Secure`,
      `${SET_COOKIE}; Domain=127.0.0.1`,
      `${SET_COOKIE}; Priority=High`,
    ]) {
      expect(() => parseSessionCookie(new Headers({ "set-cookie": invalid }), AUTHORITY)).toThrow(
        "invalid session cookie",
      );
    }
  });

  it("validates Modern endpoint segments without inventing a fixed depth", () => {
    expect(() => assertModernUnaryEndpoint("session/nested/action")).not.toThrow();
    expect(() => assertModernStreamEndpoint("session/nested/follow")).not.toThrow();
    expect(() => assertModernUnaryEndpoint("$events")).toThrow(
      "Invalid Modern DSH Remote endpoint",
    );
    expect(() => assertModernStreamEndpoint("session/../follow")).toThrow(
      "Invalid Modern DSH Remote endpoint",
    );
  });

  it("redacts Modern credentials before diagnostic tail truncation", () => {
    const canary = "TOP_SECRET_CANARY";
    const trailing = "x".repeat(7_980);
    const tokenDiagnostic = redactModernCredential(`?token=${canary}${trailing}`);
    const cookieDiagnostic = redactModernCredential(
      `dsh-auth-${"A".repeat(43)}=v1.${canary}.signature${trailing}`,
    );

    expect(tokenDiagnostic).toContain("token=<redacted>");
    expect(cookieDiagnostic).toContain("=<redacted>");
    expect(`${tokenDiagnostic}${cookieDiagnostic}`).not.toContain("SECRET_CANARY");
  });

  it("does not start DSH for pre-cancelled calls or invalid carrier targets", async () => {
    const { connection, spawn } = harness(vi.fn());
    const controller = new AbortController();
    controller.abort();

    await expect(connection.call("session/list", {}, controller.signal)).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(() => connection.openStream("$events", {}, controller.signal)).toThrow(
      expect.objectContaining({ code: "cancelled" }),
    );
    await expect(connection.call("$events", {})).rejects.toThrow(
      "Invalid Modern DSH Remote endpoint",
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects timer values above Node's real timer ceiling", () => {
    expect(
      () =>
        new ModernRemoteConnection({
          command: "dsh",
          startupTimeoutMs: 2_147_483_648,
        }),
    ).toThrow("2147483647");
  });

  it("bounds total pre-ready stdout bytes instead of only the current line", async () => {
    const readiness = `dsh web: http://${AUTHORITY}/?token=${TOKEN}`;
    const prefix = "a\nb\nc\n";
    const total = Buffer.byteLength(`${prefix}${readiness}\n`);
    for (const allowance of [total, total + 1]) {
      const child = fakeChild();
      const setup = harness(
        vi.fn(() => Promise.resolve(authResponse())),
        {
          child,
          readiness: `${prefix}${readiness}`,
          connectionOptions: { maxReadinessBytes: allowance },
        },
      );
      await expect(setup.connection.connect()).resolves.toBeUndefined();
      await setup.connection.close();
    }
    const child = fakeChild();
    const setup = harness(
      vi.fn(() => Promise.resolve(authResponse())),
      {
        child,
        readiness: `${prefix}${readiness}`,
        connectionOptions: { maxReadinessBytes: total - 1 },
      },
    );
    await expect(setup.connection.connect()).rejects.toMatchObject({ code: "protocolError" });
  });

  it("aborts and drains an in-flight readiness wait during close", async () => {
    const child = fakeChild();
    const { connection } = harness(vi.fn(), { child, readiness: "" });
    const connecting = connection.connect();

    await expect(connection.close()).resolves.toBeUndefined();
    await expect(connecting).rejects.toMatchObject({ code: "cancelled" });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("aborts and drains an in-flight token exchange during close", async () => {
    const child = fakeChild();
    const fetch = vi.fn<ModernRemoteConnectionDependencies["fetch"]>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const { connection } = harness(fetch, { child });
    const connecting = connection.connect();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());

    await expect(connection.close()).resolves.toBeUndefined();
    await expect(connecting).rejects.toMatchObject({ code: "unavailable" });
  });

  it("enforces HTTP response byte bounds at limit minus one, limit, and limit plus one", async () => {
    const body = JSON.stringify({
      type: "server-response",
      rpcId: "fixture-id",
      result: { ok: true, value: { padding: "x".repeat(64) } },
    });
    const bytes = Buffer.byteLength(body);
    for (const allowance of [bytes, bytes + 1]) {
      const setup = harness(
        vi.fn((_url, init) =>
          Promise.resolve(
            init.method === "GET"
              ? authResponse()
              : new Response(body, {
                  headers: {
                    "content-length": String(bytes),
                    "content-type": "application/json",
                  },
                }),
          ),
        ),
        { connectionOptions: { maxHttpResponseBytes: allowance } },
      );
      await expect(setup.connection.call("session/modelCatalog", {})).resolves.toMatchObject({
        ok: true,
      });
      await setup.connection.close();
    }
    const setup = harness(
      vi.fn((_url, init) =>
        Promise.resolve(
          init.method === "GET"
            ? authResponse()
            : new Response(body, {
                headers: {
                  "content-length": String(bytes),
                  "content-type": "application/json",
                },
              }),
        ),
      ),
      { connectionOptions: { maxHttpResponseBytes: bytes - 1 } },
    );
    await expect(setup.connection.call("session/modelCatalog", {})).rejects.toMatchObject({
      code: "protocolError",
    });
    await setup.connection.close();
  });

  it("uses fixed secret-free diagnostics for invalid unary JSON and UTF-8", async () => {
    const canary = "BARE_RESPONSE_SECRET_CANARY";
    const cases = [
      {
        body: `{"value":"${canary}", invalid}`,
        diagnostic: "DeepSeek Harness Remote response was not valid JSON",
      },
      {
        body: Buffer.concat([Buffer.from(`{"value":"${canary}`), Buffer.from([0xff])]),
        diagnostic: "DeepSeek Harness Remote response was not valid UTF-8",
      },
    ];
    for (const item of cases) {
      const setup = harness(
        vi.fn((_url, init) =>
          Promise.resolve(
            init.method === "GET"
              ? authResponse()
              : new Response(item.body, { headers: { "content-type": "application/json" } }),
          ),
        ),
      );

      const failure: Error = await setup.connection.call("session/list", {}).then(
        () => {
          throw new Error("expected an invalid unary response");
        },
        (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
      );
      expect(failure).toMatchObject({ code: "protocolError" });
      expect(failure.message).toContain(item.diagnostic);
      expect(failure.message).not.toContain(canary);
      await setup.connection.close();
    }
  });

  it("cancels rejected HTTP and bootstrap response bodies", async () => {
    const bootstrapCancelled = vi.fn();
    const bootstrap = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("unauthorized"));
        },
        cancel: bootstrapCancelled,
      }),
      { status: 401 },
    );
    const first = harness(vi.fn(() => Promise.resolve(bootstrap)));
    await expect(first.connection.connect()).rejects.toMatchObject({
      code: "authenticationRequired",
    });
    expect(bootstrapCancelled).toHaveBeenCalledOnce();

    const unaryCancelled = vi.fn();
    const second = harness(
      vi.fn((_url, init) =>
        Promise.resolve(
          init.method === "GET"
            ? authResponse()
            : new Response(
                new ReadableStream({
                  start(controller) {
                    controller.enqueue(new TextEncoder().encode("unavailable"));
                  },
                  cancel: unaryCancelled,
                }),
                { status: 503 },
              ),
        ),
      ),
    );
    await expect(second.connection.call("session/list", {})).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(unaryCancelled).toHaveBeenCalledOnce();
    await second.connection.close();
  });

  it("preserves caller cancellation while reading a response body", async () => {
    const caller = new AbortController();
    let bodyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      bodyStarted = resolve;
    });
    const first = harness(
      vi.fn((_url, init) => {
        if (init.method === "GET") return Promise.resolve(authResponse());
        bodyStarted();
        return Promise.resolve(blockedJsonResponse(init.signal as AbortSignal));
      }),
    );
    const cancelled = first.connection.call("session/list", {}, caller.signal);
    await started;
    caller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "cancelled" });
    await first.connection.close();
  });

  it("preserves unary timeout classification while reading a response body", async () => {
    const second = harness(
      vi.fn((_url, init) =>
        Promise.resolve(
          init.method === "GET" ? authResponse() : blockedJsonResponse(init.signal as AbortSignal),
        ),
      ),
      { connectionOptions: { unaryTimeoutMs: 5 } },
    );
    await expect(second.connection.call("session/list", {})).rejects.toMatchObject({
      code: "unavailable",
    });
    await second.connection.close();
  });

  it("disables the short unary timeout only for a caller-owned lifetime", async () => {
    const caller = new AbortController();
    let bodyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      bodyStarted = resolve;
    });
    const setup = harness(
      vi.fn((_url, init) => {
        if (init.method === "GET") return Promise.resolve(authResponse());
        bodyStarted();
        return Promise.resolve(blockedJsonResponse(init.signal as AbortSignal));
      }),
      { connectionOptions: { unaryTimeoutMs: 5 } },
    );
    const pending = setup.connection.call("commands/execute", {}, caller.signal, {
      timeoutMs: null,
    });
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await started;
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(settled).toBe(false);

    caller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    await setup.connection.close();
  });

  it("refuses an unbounded unary call without a caller AbortSignal", async () => {
    const setup = harness(vi.fn(() => Promise.resolve(authResponse())));
    await expect(
      setup.connection.call("commands/execute", {}, undefined, { timeoutMs: null }),
    ).rejects.toThrow(/requires an AbortSignal/u);
    expect(setup.spawn).not.toHaveBeenCalled();
    await setup.connection.close();
  });

  it("bounds queued stream frame count at limit minus one, limit, and limit plus one", async () => {
    for (const count of [1, 2, 3]) {
      let socket: FakeWebSocket | undefined;
      const setup = harness(
        vi.fn(() => Promise.resolve(authResponse())),
        {
          createWebSocket: () => {
            socket = new FakeWebSocket((message) => {
              if (message.type !== "open") return;
              const streamId = String(message.streamId);
              queueMicrotask(() => {
                for (let index = 0; index < count - 1; index += 1) {
                  socket?.server({ type: "item", value: index }, streamId);
                }
                socket?.server({ type: "end" }, streamId);
              });
            });
            queueMicrotask(() => socket?.open());
            return socket;
          },
          connectionOptions: { maxQueuedStreamFrames: 2 },
        },
      );
      const consume = async (): Promise<unknown[]> => {
        const values: unknown[] = [];
        for await (const value of setup.connection.openStream("$events", {})) values.push(value);
        return values;
      };
      if (count <= 2) await expect(consume()).resolves.toHaveLength(count - 1);
      else await expect(consume()).rejects.toMatchObject({ code: "protocolError" });
      await setup.connection.close();
    }
  });

  it("bounds queued stream bytes at limit minus one, limit, and limit plus one", async () => {
    const streamId = "fixture-id";
    const frames = [
      JSON.stringify({ type: "item", streamId, value: "value" }),
      JSON.stringify({ type: "end", streamId }),
    ];
    const bytes = frames.reduce((total, frame) => total + Buffer.byteLength(frame), 0);
    for (const allowance of [bytes + 1, bytes, bytes - 1]) {
      let socket: FakeWebSocket | undefined;
      const setup = harness(
        vi.fn(() => Promise.resolve(authResponse())),
        {
          createWebSocket: () => {
            socket = new FakeWebSocket((message) => {
              if (message.type !== "open") return;
              queueMicrotask(() => {
                for (const frame of frames) socket?.serverRaw(frame);
              });
            });
            queueMicrotask(() => socket?.open());
            return socket;
          },
          connectionOptions: { maxQueuedStreamBytes: allowance },
        },
      );
      const consume = async (): Promise<unknown[]> => {
        const values: unknown[] = [];
        for await (const value of setup.connection.openStream("$events", {})) values.push(value);
        return values;
      };
      if (allowance >= bytes) await expect(consume()).resolves.toEqual(["value"]);
      else await expect(consume()).rejects.toMatchObject({ code: "protocolError" });
      await setup.connection.close();
    }
  });

  it("maps a real WebSocket 401 upgrade to authenticationRequired", async () => {
    let observedCookie: string | undefined;
    const server = createServer();
    server.on("upgrade", (request, socket) => {
      observedCookie = request.headers.cookie;
      socket.end(
        "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 12\r\n\r\nunauthorized",
      );
    });
    const port = await listen(server);
    const authority = `127.0.0.1:${String(port)}`;
    const setup = harness(
      vi.fn(() => Promise.resolve(authResponse(authority))),
      {
        readiness: `dsh web: http://127.0.0.1:${String(port)}/?token=${TOKEN}`,
        createWebSocket: createNodeWebSocket,
      },
    );
    try {
      const iterator = setup.connection.openStream("$events", {})[Symbol.asyncIterator]();
      await expect(iterator.next()).rejects.toMatchObject({ code: "authenticationRequired" });
      expect(observedCookie).toBe(sessionCookie(authority).cookie);
    } finally {
      await setup.connection.close();
      await closeServer(server);
    }
  });

  it("enforces maxPayload through a real WebSocket", async () => {
    const server = createServer();
    const webSockets = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
      webSockets.handleUpgrade(request, socket, head, (client) => {
        client.on("message", () => {
          client.send("x".repeat(256));
        });
      });
    });
    const port = await listen(server);
    const authority = `127.0.0.1:${String(port)}`;
    const setup = harness(
      vi.fn(() => Promise.resolve(authResponse(authority))),
      {
        readiness: `dsh web: http://${authority}/?token=${TOKEN}`,
        createWebSocket: createNodeWebSocket,
        connectionOptions: { maxWebSocketPayloadBytes: 128 },
      },
    );
    try {
      const iterator = setup.connection.openStream("$events", {})[Symbol.asyncIterator]();
      await expect(iterator.next()).rejects.toMatchObject({ code: "protocolError" });
    } finally {
      await setup.connection.close();
      for (const client of webSockets.clients) client.terminate();
      await new Promise<void>((resolve) => webSockets.close(() => resolve()));
      await closeServer(server);
    }
  });

  it("sanitizes stream failures and never retains their details", async () => {
    const canary = "SUPER_SECRET_CANARY";
    let socket: FakeWebSocket | undefined;
    const setup = harness(
      vi.fn(() => Promise.resolve(authResponse())),
      {
        createWebSocket: () => {
          socket = new FakeWebSocket((message) => {
            if (message.type !== "open") return;
            queueMicrotask(() =>
              socket?.server(
                {
                  type: "error",
                  error: {
                    code: `api_key=${canary}`,
                    message: `api_key=${canary}`,
                    details: { secret: canary },
                  },
                },
                String(message.streamId),
              ),
            );
          });
          queueMicrotask(() => socket?.open());
          return socket;
        },
      },
    );
    const iterator = setup.connection.openStream("$events", {})[Symbol.asyncIterator]();
    const failure = await iterator.next().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(JSON.stringify(failure)).not.toContain(canary);
    expect(failure).toMatchObject({
      nativeCode: "api_key=[redacted]",
      remoteFailure: { code: "api_key=[redacted]", details: {} },
    });
    await setup.connection.close();
  });

  it("sanitizes unary Remote failures before returning them", async () => {
    const canary = "SUPER_SECRET_CANARY";
    const setup = harness(
      vi.fn((_url, init) =>
        Promise.resolve(
          init.method === "GET"
            ? authResponse()
            : jsonResponse({
                type: "server-response",
                rpcId: "fixture-id",
                result: {
                  ok: false,
                  error: {
                    code: `api_key=${canary}`,
                    message: `secret=${canary}`,
                    details: { secret: canary },
                  },
                },
              }),
        ),
      ),
    );

    const result = await setup.connection.call("session/list", {});
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "api_key=[redacted]", message: "secret=[redacted]", details: {} },
    });
    await setup.connection.close();
  });

  it("contains late fault listeners and respects unsubscription", async () => {
    const child = fakeChild();
    const setup = harness(
      vi.fn(() => Promise.resolve(authResponse())),
      { child },
    );
    await setup.connection.connect();
    setup.connection.onFault(() => {
      throw new Error("listener canary");
    });
    Object.assign(child, { exitCode: 1 });
    expect(() => child.emit("exit", 1, null)).not.toThrow();
    expect(setup.killProcessTree).toHaveBeenCalledOnce();

    const late = vi.fn();
    const unsubscribe = setup.connection.onFault(late);
    unsubscribe();
    await Promise.resolve();
    expect(late).not.toHaveBeenCalled();
    await setup.connection.close();
    expect(setup.killProcessTree).toHaveBeenCalledOnce();
  });
});
