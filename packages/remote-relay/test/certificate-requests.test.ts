import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:https";
import { connect, createServer, Socket, type AddressInfo, type Server } from "node:net";
import type * as Net from "node:net";
import type { Duplex } from "node:stream";
import { createServer as createTlsServer } from "node:tls";
import { afterEach, expect, it, vi } from "vitest";
import { createRelay, type RelayOptions } from "../src/index.js";
import { defaultCertificateDirectory, paths } from "../src/protocol.js";
import { certPath, credentials, fakeAgent, keyPath, phone } from "./helpers.js";

vi.mock("node:net", async (importOriginal) => {
  const net = await importOriginal<typeof Net>();
  return { ...net, connect: vi.fn(net.connect) };
});

let relay: ReturnType<typeof createRelay>;
let port: number;
const sockets = new Set<Duplex>();
const targets: Server[] = [];

async function start(options: Partial<RelayOptions> = {}) {
  relay = createRelay({
    domain: "relay.test",
    controlHost: "relay.test",
    cert: certPath,
    key: keyPath,
    ...options,
  });
  relay.server.listen(0, "127.0.0.1");
  await once(relay.server, "listening");
  port = (relay.server.address() as AddressInfo).port;
  return relay;
}

async function echo() {
  const peers: Socket[] = [];
  const server = createServer((socket) => {
    peers.push(socket);
    sockets.add(socket);
    socket.on("error", () => {});
    socket.pipe(socket);
  });
  targets.push(server);
  server.listen(0);
  await once(server, "listening");
  const targetPort = (server.address() as AddressInfo).port;
  return {
    peers,
    server,
    directory: `https://localhost:${targetPort}/dir`,
    authority: `localhost:${targetPort}`,
  };
}

function controlRequest(path: string, token?: string) {
  return new Promise<{ status: number; body: string; retryAfter: string | undefined }>(
    (resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          servername: "relay.test",
          rejectUnauthorized: false,
          method: "POST",
          path,
          agent: false,
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        },
        (response) => {
          let body = "";
          response.on("data", (chunk) => (body += chunk));
          response.on("end", () => {
            assert.ok(response.statusCode);
            resolve({
              status: response.statusCode,
              body,
              retryAfter: response.headers["retry-after"],
            });
          });
          response.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end();
    },
  );
}

function tunnel(authority: string, token?: string) {
  return new Promise<{ status: number; socket: Duplex }>((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      servername: "relay.test",
      rejectUnauthorized: false,
      method: "CONNECT",
      path: authority,
      agent: false,
      headers: token ? { "Proxy-Authorization": `Bearer ${token}` } : {},
    });
    req.on("error", reject);
    req.on("connect", (response, socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      assert.ok(response.statusCode);
      resolve({ status: response.statusCode, socket });
    });
    req.end();
  });
}

async function exchange(socket: Duplex, text = "certificate request") {
  const received = new Promise<string>((resolve) => {
    let body = "";
    const data = (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length >= text.length) {
        socket.off("data", data);
        resolve(body);
      }
    };
    socket.on("data", data);
  });
  socket.resume();
  socket.write(text);
  expect(await received).toBe(text);
}

async function register(options: Parameters<typeof fakeAgent>[0] = {}) {
  const agent = await fakeAgent({ port, ...options });
  const registration = await agent.registration;
  assert.ok(registration.token);
  return { agent, token: registration.token, registration };
}

afterEach(async () => {
  vi.useRealTimers();
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await relay?.close();
  await Promise.all(
    targets
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  vi.restoreAllMocks();
});

it("issues a random registration credential and the default directory without automatic control certificates", async () => {
  await start();
  const first = await register();
  const second = await register();
  expect(first.registration.certificateAuthority).toEqual({
    directory: defaultCertificateDirectory,
  });
  expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(Buffer.from(first.token, "base64url")).toHaveLength(32);
  expect(second.token).not.toBe(first.token);
});

it("notifies every online computer without interrupting control or phone forwarding, and registers with the new directory", async () => {
  const initial = "https://initial.test/directory";
  await start({ certificateDirectory: initial });
  const tls = createTlsServer(credentials, (socket) => socket.pipe(socket));
  const first = await register({ tcp: (stream) => tls.emit("connection", stream) });
  const second = await register();
  expect(first.registration.certificateAuthority).toEqual({ directory: initial });
  const mobile = phone(first.registration.hostname, undefined, port);
  sockets.add(mobile);
  await once(mobile, "secureConnect");
  await exchange(mobile, "before switch");
  const directory = "https://new.test/directory";
  relay.setCertificateDirectory(directory);
  await vi.waitFor(() => {
    for (const { agent } of [first, second]) {
      expect(agent.notices).toEqual([{ certificateAuthority: { directory } }]);
      expect(agent.ws.readyState).toBe(1);
      expect(agent.session.destroyed).toBe(false);
    }
  });
  relay.setCertificateDirectory(directory);
  await exchange(mobile, "after switch");
  expect(first.agent.notices).toHaveLength(1);
  const next = await register();
  expect(next.registration.certificateAuthority).toEqual({ directory });
});

it("rejects non-HTTPS and malformed directories at construction and runtime", async () => {
  for (const directory of ["http://localhost/dir", "file:///dir", "not a URL"]) {
    expect(() => createRelay({ domain: "relay.test", certificateDirectory: directory })).toThrow();
  }
  await start();
  for (const directory of ["http://localhost/dir", "not a URL"]) {
    expect(() => relay.setCertificateDirectory(directory)).toThrow();
  }
  expect((await register()).registration.certificateAuthority).toEqual({
    directory: defaultCertificateDirectory,
  });
});

it("forwards certificate bytes independently of Usage and deployment callbacks", async () => {
  const target = await echo();
  const onRequest = vi.fn((_request, response) => response.writeHead(418).end());
  const onUsage = vi.fn();
  const onConnection = vi.fn();
  await start({
    certificateDirectory: target.directory,
    rate: 1,
    dailyQuota: 1,
    onRequest,
    onUsage,
    onConnection,
  });
  const { token } = await register();
  onConnection.mockClear();
  const connection = await tunnel(target.authority, token);
  expect(connection.status).toBe(200);
  await exchange(connection.socket, "x".repeat(100_000));
  assert.ok(target.peers[0]);
  target.peers[0].write("unsolicited response");
  expect((await once(connection.socket, "data"))[0].toString()).toBe("unsolicited response");
  expect(onRequest).not.toHaveBeenCalled();
  expect(onUsage).not.toHaveBeenCalled();
  expect(onConnection).not.toHaveBeenCalled();
});

it("rejects wrong hosts, ports and credentials before connecting, including after a directory switch", async () => {
  const target = await echo();
  const next = await echo();
  await start({ certificateDirectory: target.directory });
  const { token } = await register();
  expect((await tunnel(target.authority)).status).toBe(407);
  expect((await tunnel(target.authority, "invalid")).status).toBe(407);
  expect((await tunnel(target.authority.replace("localhost", "127.0.0.1"), token)).status).toBe(
    403,
  );
  expect((await tunnel("localhost:443", token)).status).toBe(403);
  expect(target.peers).toHaveLength(0);
  const existing = await tunnel(target.authority, token);
  relay.setCertificateDirectory(next.directory);
  expect((await tunnel(target.authority, token)).status).toBe(403);
  expect((await tunnel(next.authority, token)).status).toBe(200);
  await exchange(existing.socket);
});

it("defaults the allowed directory port to 443", async () => {
  const target = await echo();
  const net = await vi.importActual<typeof Net>("node:net");
  await start({ certificateDirectory: "https://localhost/dir" });
  const { token } = await register();
  expect((await tunnel("localhost:444", token)).status).toBe(403);
  vi.mocked(connect).mockImplementationOnce(() =>
    net.connect({ host: "localhost", port: (target.server.address() as AddressInfo).port }),
  );
  const connection = await tunnel("localhost:443", token);
  expect(connection.status).toBe(200);
  expect(connect).toHaveBeenLastCalledWith({ host: "localhost", port: 443 });
  await exchange(connection.socket);
});

it("forwards bytes already received with the CONNECT headers", async () => {
  const target = await echo();
  await start({ certificateDirectory: target.directory });
  const { token } = await register();
  const socket = phone("relay.test", undefined, port);
  sockets.add(socket);
  await once(socket, "secureConnect");
  const received = new Promise<string>((resolve) => {
    let body = "";
    socket.on("data", (chunk) => {
      body += chunk.toString();
      if (body.endsWith("early payload")) resolve(body);
    });
  });
  socket.write(
    `CONNECT ${target.authority} HTTP/1.1\r\nHost: ${target.authority}\r\nProxy-Authorization: Bearer ${token}\r\n\r\nearly payload`,
  );
  expect(await received).toBe("HTTP/1.1 200 Connection Established\r\n\r\nearly payload");
});

it("limits each credential to four tunnels and releases a closed slot", async () => {
  const target = await echo();
  await start({ certificateDirectory: target.directory });
  const { token } = await register();
  const connections = await Promise.all(
    Array.from({ length: 4 }, () => tunnel(target.authority, token)),
  );
  expect(connections.map((connection) => connection.status)).toEqual([200, 200, 200, 200]);
  expect((await tunnel(target.authority, token)).status).toBe(429);
  const other = await register();
  expect((await tunnel(target.authority, other.token)).status).toBe(200);
  assert.ok(connections[0]);
  connections[0].socket.destroy();
  await vi.waitFor(() => expect(target.peers[0]?.destroyed).toBe(true));
  expect((await tunnel(target.authority, token)).status).toBe(200);
});

it.each(["replace", "disconnect", "close", "heartbeat"] as const)(
  "revokes credentials and closes their tunnels on %s",
  async (reason) => {
    const target = await echo();
    await start({
      certificateDirectory: target.directory,
      ...(reason === "heartbeat" ? { heartbeatInterval: 100 } : {}),
    });
    const { agent, token, registration } = await register({ autoPong: reason !== "heartbeat" });
    const connection = await tunnel(target.authority, token);
    const closed = once(connection.socket, "close");
    connection.socket.resume();
    if (reason === "replace") {
      const replacement = await register({ privateKey: agent.privateKey });
      expect(replacement.token).not.toBe(token);
      expect((await tunnel(target.authority, replacement.token)).status).toBe(200);
    } else if (reason === "disconnect") {
      const name = registration.hostname.split(".")[0];
      assert.ok(name);
      relay.disconnect(name);
    } else if (reason === "close") agent.ws.terminate();
    await closed;
    expect((await tunnel(target.authority, token)).status).toBe(407);
    expect((await controlRequest(paths.externalAccount, token)).status).toBe(401);
  },
);

it("returns 502 when the certificate authority cannot be reached", async () => {
  const target = await echo();
  await new Promise<void>((resolve) => target.server.close(() => resolve()));
  await start({ certificateDirectory: target.directory });
  const { token } = await register();
  expect((await tunnel(target.authority, token)).status).toBe(502);
});

it("returns 502 after ten seconds connecting and releases the pending tunnel", async () => {
  const target = await echo();
  await start({ certificateDirectory: target.directory });
  const { token } = await register();
  const pending = new Socket();
  const dialed = new Promise<void>((resolve) => {
    vi.mocked(connect).mockImplementationOnce(() => {
      resolve();
      return pending;
    });
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const result = tunnel(target.authority, token);
  await dialed;
  await vi.advanceTimersByTimeAsync(9_999);
  expect(pending.destroyed).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect((await result).status).toBe(502);
  expect(pending.destroyed).toBe(true);
  expect((await tunnel(target.authority, token)).status).toBe(200);
});

it("closes tunnels after 60 seconds with no traffic in either direction", async () => {
  const target = await echo();
  await start({ certificateDirectory: target.directory });
  const { token } = await register();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const connection = await tunnel(target.authority, token);
  await vi.advanceTimersByTimeAsync(59_000);
  await exchange(connection.socket);
  await vi.advanceTimersByTimeAsync(59_000);
  expect(connection.socket.destroyed).toBe(false);
  assert.ok(target.peers[0]);
  const pushed = once(connection.socket, "data");
  target.peers[0].write("upstream activity");
  await pushed;
  await vi.advanceTimersByTimeAsync(59_000);
  expect(connection.socket.destroyed).toBe(false);
  const closed = once(connection.socket, "close");
  await vi.advanceTimersByTimeAsync(1_000);
  await closed;
});

it.each([
  { result: { keyId: "key-id", hmacKey: "private-base64url-key" }, status: 200 },
  { result: undefined, status: 404 },
  { result: { retryAfter: 120 }, status: 429 },
  { result: {}, status: 503 },
])(
  "maps external-account results to $status without calling onRequest or logging credentials",
  async ({ result, status }) => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const externalAccount = vi.fn(async () => result);
    const onRequest = vi.fn((_request, response) => response.writeHead(418).end());
    await start({ externalAccount, onRequest, check: () => ({ name: "alice" }) });
    const { agent, token } = await register();
    const response = await controlRequest(paths.externalAccount, token);
    expect(response.status).toBe(status);
    expect(externalAccount).toHaveBeenCalledWith({
      id: agent.hostname.split(".")[0],
      name: "alice",
    });
    if (status === 200) expect(JSON.parse(response.body)).toEqual(result);
    if (status === 429) expect(response.retryAfter).toBe("120");
    expect(write.mock.calls.flat().join("")).not.toContain("private-base64url-key");
    expect(onRequest).not.toHaveBeenCalled();
    expect((await controlRequest("/custom")).status).toBe(418);
    expect(onRequest).toHaveBeenCalledTimes(1);
  },
);

it("returns 401 before calling the external-account handler for invalid credentials", async () => {
  const externalAccount = vi.fn();
  const onRequest = vi.fn();
  await start({ externalAccount, onRequest });
  for (const token of [undefined, "invalid"]) {
    expect((await controlRequest(paths.externalAccount, token)).status).toBe(401);
  }
  expect(externalAccount).not.toHaveBeenCalled();
  expect(onRequest).not.toHaveBeenCalled();
});

it("returns 404 without an external-account handler", async () => {
  await start();
  const { token } = await register();
  expect((await controlRequest(paths.externalAccount, token)).status).toBe(404);
});

it("does not deliver credentials if the registration expires while the handler runs", async () => {
  let finish!: (account: { keyId: string; hmacKey: string }) => void;
  const account = new Promise<{ keyId: string; hmacKey: string }>((resolve) => {
    finish = resolve;
  });
  const externalAccount = vi.fn(() => account);
  await start({ externalAccount });
  const { agent, token } = await register();
  const result = controlRequest(paths.externalAccount, token);
  await vi.waitFor(() => expect(externalAccount).toHaveBeenCalledTimes(1));
  await register({ privateKey: agent.privateKey });
  finish({ keyId: "key", hmacKey: "secret" });
  expect((await result).status).toBe(401);
});

it("returns 503 when the external-account handler throws", async () => {
  await start({
    externalAccount: async () => {
      throw new Error("unavailable");
    },
  });
  const { token } = await register();
  expect((await controlRequest(paths.externalAccount, token)).status).toBe(503);
});
