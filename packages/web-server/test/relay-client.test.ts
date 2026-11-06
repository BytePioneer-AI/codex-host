import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, type Socket } from "node:net";
import { it, type TestContext } from "node:test";
import { createRequire } from "node:module";
import type { WebSocket } from "ws";
import { deriveId } from "@codexhost/remote-relay/protocol";
import { connectRelay } from "../src/remote-relay/client.ts";
import { relayIdentity } from "../src/remote-relay/identity.ts";
import { credentials, delay, relayData, startRelay, until } from "./support/relay.ts";

function proxyEnvironment(t: TestContext, value = "") {
  const upper = process.env.HTTPS_PROXY;
  const lower = process.env.https_proxy;
  process.env.HTTPS_PROXY = value;
  process.env.https_proxy = "";
  t.after(() => {
    if (upper === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = upper;
    if (lower === undefined) delete process.env.https_proxy;
    else process.env.https_proxy = lower;
  });
}

function client(
  t: TestContext,
  host: string,
  extra: Partial<Parameters<typeof connectRelay>[0]> = {},
) {
  const identity = relayIdentity(relayData(t));
  const registrations: string[] = [];
  const stopped: string[] = [];
  let attempts = 0;
  const close = connectRelay({
    host,
    identity,
    connecting: () => {
      attempts++;
    },
    registered: (hostname) => registrations.push(hostname),
    stopped: (reason) => stopped.push(reason),
    tcp: (stream) => stream.close(),
    ...extra,
  });
  t.after(close);
  return { registrations, stopped, identity, close, attempts: () => attempts };
}

it("registers with the real Relay, survives its restart, and stops when replaced", async (t) => {
  proxyEnvironment(t);
  const relay = await startRelay(t);
  const a = client(t, `localhost:${relay.port}`);
  await until(() => a.registrations.length === 1);
  assert.equal(a.registrations[0], `${deriveId(a.identity.publicKey)}.relay.test`);
  await relay.close();
  const restarted = await startRelay(t);
  // Restart the same Relay listener on its original port.
  await new Promise<void>((resolve) => restarted.server.close(() => resolve()));
  restarted.server.listen(relay.port, "localhost");
  await once(restarted.server, "listening");
  await until(() => a.registrations.length === 2);
  const b = client(t, `localhost:${relay.port}`, { identity: a.identity });
  await until(() => b.registrations.length === 1 && a.stopped[0] === "replaced");
  const attempts = a.attempts();
  await delay(1_100);
  assert.equal(a.attempts(), attempts);
});

it("stops after a rejected signature or unsupported upgrade version", async (t) => {
  proxyEnvironment(t);
  const relay = await startRelay(t);
  const identity = relayIdentity(relayData(t));
  const other = relayIdentity(relayData(t));
  const rejected = client(t, `localhost:${relay.port}`, {
    identity: { ...identity, privateKey: other.privateKey },
  });
  await until(() => rejected.stopped[0] === "rejected");
  const server = createHttpsServer(credentials);
  server.on("upgrade", (_request, socket) =>
    socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
  );
  server.listen(0, "localhost");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const unsupported = client(t, `localhost:${(server.address() as { port: number }).port}`);
  await until(() => unsupported.stopped[0] === "unsupported-version");
  await delay(1_100);
  assert.equal(unsupported.attempts(), 1);
  assert.equal(rejected.attempts(), 1);
});

it("reconnects after Relay stops sending ping", async (t) => {
  proxyEnvironment(t);
  const relay = await startRelay(t, 20);
  const a = client(t, `localhost:${relay.port}`, { heartbeatTimeout: 150 });
  await until(() => a.registrations.length === 1);
  await delay(200);
  assert.equal(a.registrations.length, 1);
  const relayWs = createRequire(import.meta.resolve("@codexhost/remote-relay"))("ws");
  t.mock.method(relayWs.WebSocket.prototype, "ping", function (this: WebSocket) {
    this.emit("pong");
  });
  await until(() => a.registrations.length === 2);
});

it("uses an HTTP CONNECT proxy with TLS verification and the configured SNI", async (t) => {
  const relay = await startRelay(t);
  const proxy = createHttpServer();
  const targets: string[] = [];
  const sockets = new Set<Socket>();
  proxy.on("connect", (request, socket, head) => {
    targets.push(request.url ?? "");
    sockets.add(socket);
    const upstream = connect({ host: "localhost", port: relay.port }, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    sockets.add(upstream);
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  });
  proxyEnvironment(t, `http://127.0.0.1:${(proxy.address() as { port: number }).port}`);
  const a = client(t, `localhost:${relay.port}`);
  await until(() => a.registrations.length === 1);
  assert.deepEqual(targets, [`localhost:${relay.port}`]);
});

for (const stage of ["proxy", "upgrade"] as const) {
  it(
    `abandons a stalled ${stage} after the 30-second attempt deadline and retries`,
    { timeout: 40_000 },
    async (t) => {
      const server = stage === "proxy" ? createHttpServer() : createHttpsServer(credentials);
      const sockets = new Set<Socket>();
      let attempts = 0;
      server.on(stage === "proxy" ? "connect" : "upgrade", (_request, socket: Socket) => {
        attempts++;
        sockets.add(socket);
        socket.on("error", () => {});
      });
      server.listen(0, "localhost");
      await once(server, "listening");
      t.after(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      });
      const address = `localhost:${(server.address() as { port: number }).port}`;
      proxyEnvironment(t, stage === "proxy" ? `http://${address}` : "");
      const started = performance.now();
      const a = client(t, address);
      await until(() => attempts === 2, 35_000);
      assert.ok(performance.now() - started >= 30_000);
      assert.equal(a.registrations.length, 0);
      assert.equal(a.stopped.length, 0);
    },
  );
}
