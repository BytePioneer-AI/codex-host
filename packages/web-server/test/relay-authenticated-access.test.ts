import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { connect as connectHttp2, type OutgoingHttpHeaders } from "node:http2";
import { request } from "node:https";
import { connect, createSecureContext } from "node:tls";
import { it, type TestContext } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { createRelay, type ConnectionEvent } from "@codexhost/remote-relay";
import { headers } from "@codexhost/remote-relay/protocol";
import { AccessAuth, CredentialConnections } from "../src/auth.ts";
import { AccessTokenStore } from "../src/access-tokens.ts";
import { RequestTrust } from "../src/request-trust.ts";
import { connectRelay } from "../src/remote-relay/client.ts";
import { relayIdentity } from "../src/remote-relay/identity.ts";
import { RelayTls } from "../src/remote-relay/tls.ts";
import { certPath, credentials, delay, keyPath, relayData, until } from "./support/relay.ts";

async function fixture(t: TestContext, legacy = false) {
  const data = relayData(t);
  const tokens = new AccessTokenStore(data);
  const secret = tokens.current().secret;
  const trust = new RequestTrust(undefined);
  const auth = new AccessAuth(tokens, trust, new CredentialConnections());
  const http = createServer((req, res) => {
    void auth.gate(req, res, (req.url ?? "/").split("?")[0] ?? "/").then((admission) => {
      if (!admission.handled) res.writeHead(200).end("ok");
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  http.on("upgrade", (req, socket, head) => {
    if (!trust.sameOrigin(req) || !auth.admitUpgrade(req, socket)) return;
    wss.handleUpgrade(req, socket, head, (ws) => ws.on("message", (message) => ws.send(message)));
  });
  const tls = new RelayTls(http, trust);
  tls.useCertificate(createSecureContext(credentials));
  const events: ConnectionEvent[] = [];
  const relay = createRelay({
    domain: "relay.test",
    controlHost: "localhost",
    cert: certPath,
    key: keyPath,
    onConnection: (event) => events.push(event),
  });
  relay.server.listen(0, "::");
  await once(relay.server, "listening");
  const port = (relay.server.address() as { port: number }).port;
  let registered!: (hostname: string) => void;
  const ready = new Promise<string>((resolve) => {
    registered = resolve;
  });
  const proxy = process.env.HTTPS_PROXY;
  const lowerProxy = process.env.https_proxy;
  process.env.HTTPS_PROXY = "";
  process.env.https_proxy = "";
  const disconnect = connectRelay({
    host: `localhost:${port}`,
    identity: relayIdentity(data),
    connecting() {},
    stopped(reason) {
      throw new Error(reason);
    },
    registered,
    tcp: (stream, request) =>
      tls.accept(
        stream,
        legacy ? { ...request, [headers.connectionId]: undefined } : request,
        `${relayIdentity(data).id}.relay.test`,
      ),
  });
  if (proxy === undefined) delete process.env.HTTPS_PROXY;
  else process.env.HTTPS_PROXY = proxy;
  if (lowerProxy === undefined) delete process.env.https_proxy;
  else process.env.https_proxy = lowerProxy;
  const hostname = await ready;
  const sessions = new Set<{ destroy(): unknown }>();
  t.after(async () => {
    for (const session of sessions) session.destroy();
    for (const ws of wss.clients) ws.terminate();
    disconnect();
    await relay.close();
    wss.close();
    tokens.close();
  });
  const send = (path: string, body?: unknown, extraHeaders = {}) =>
    new Promise<{ status: number; cookie?: string }>((resolve, reject) => {
      const options = {
        host: "127.0.0.1",
        port,
        servername: hostname,
        rejectUnauthorized: false,
        agent: false as const,
        path,
        method: body === undefined ? "GET" : "POST",
        headers: { host: hostname, ...extraHeaders },
        ALPNProtocols: ["http/1.1"],
      };
      const req = request(options, (res) => {
        res.resume();
        res.once("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            ...(res.headers["set-cookie"]?.[0]
              ? { cookie: res.headers["set-cookie"][0].split(";")[0] }
              : {}),
          }),
        );
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  const authenticated = () =>
    events.filter((event) => event.type === "phone" && event.state === "authenticated");
  return { secret, tokens, send, authenticated, events, hostname, port, sessions };
}

for (const alpn of ["h2", "http/1.1"]) {
  it(
    `releases relay slots when ${alpn} clients disconnect without TLS shutdown`,
    { timeout: 10_000 },
    async (t) => {
      const f = await fixture(t);
      for (let i = 0; i < 33; i++) {
        const phone = connect({
          host: "127.0.0.1",
          port: f.port,
          servername: f.hostname,
          rejectUnauthorized: false,
          ALPNProtocols: [alpn],
        });
        f.sessions.add(phone);
        await once(phone, "secureConnect");
        if (alpn === "h2") {
          const session = connectHttp2(`https://${f.hostname}`, { createConnection: () => phone });
          f.sessions.add(session);
          const request = session.request({ ":path": "/" });
          request.resume();
          await once(request, "end");
        } else {
          phone.write(`GET / HTTP/1.1\r\nHost: ${f.hostname}\r\n\r\n`);
          await once(phone, "data");
        }
        phone.destroy();
        await until(
          () =>
            f.events.filter((event) => event.type === "phone" && event.state === "close").length ===
            i + 1,
          1_000,
        );
      }
    },
  );
}

it(
  "reports only valid login/cookie/bearer authentication, never scans, invalid tokens, assets or spoofed IP headers",
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t);
    assert.equal((await f.send("/")).status, 401);
    assert.equal((await f.send("/assets/public.js")).status, 200);
    assert.equal((await f.send("/api/auth/login", { token: "wrong" })).status, 401);
    assert.equal((await f.send("/api/auth/login", { token: f.tokens.localToken })).status, 401);
    assert.equal(
      (await f.send("/api/auth/login", { token: f.secret }, { origin: "https://evil.test" }))
        .status,
      403,
    );
    assert.equal(
      (
        await f.send("/", undefined, {
          "x-forwarded-for": "198.51.100.99",
          "relay-connection-id": "forged",
        })
      ).status,
      401,
    );
    await delay(20);
    assert.equal(f.authenticated().length, 0);
    const login = await f.send("/api/auth/login", { token: f.secret });
    assert.equal(login.status, 200);
    assert.ok(login.cookie);
    await until(() => f.authenticated().length === 1);
    assert.equal(
      (await f.send("/", undefined, { cookie: login.cookie, "x-forwarded-for": "198.51.100.99" }))
        .status,
      200,
    );
    assert.equal(
      (await f.send("/", undefined, { authorization: `Bearer ${f.secret}` })).status,
      200,
    );
    await until(() => f.authenticated().length === 3);
    for (const event of f.authenticated()) {
      assert.equal(event.ip, "::ffff:127.0.0.1");
      assert.ok(
        f.events.some(
          (opened) =>
            opened.type === "phone" &&
            opened.state === "open" &&
            opened.id === event.id &&
            opened.ip === event.ip,
        ),
      );
    }
  },
);

it(
  "deduplicates multiplexed authenticated HTTP/2 requests per connection and reports renewed authentication on a new UTC day",
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t);
    const session = connectHttp2(`https://${f.hostname}`, {
      createConnection: () =>
        connect({
          host: "127.0.0.1",
          port: f.port,
          servername: f.hostname,
          rejectUnauthorized: false,
          ALPNProtocols: ["h2"],
        }),
    });
    f.sessions.add(session);
    const send = (headers: OutgoingHttpHeaders) =>
      new Promise<number>((resolve, reject) => {
        const stream = session.request({ ":path": "/api/auth/status", ...headers });
        let status = 0;
        stream.on("response", (response) => {
          status = Number(response[":status"]);
        });
        stream.on("error", reject);
        stream.on("end", () => resolve(status));
        stream.resume();
        stream.end();
      });
    assert.equal(await send({}), 401);
    await Promise.all(
      Array.from({ length: 8 }, () => send({ authorization: `Bearer ${f.secret}` })),
    );
    await until(() => f.authenticated().length === 1);
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 86400_000 });
    assert.equal(await send({ authorization: `Bearer ${f.secret}` }), 200);
    await until(() => f.authenticated().length === 2);
    assert.equal(f.authenticated()[0]?.id, f.authenticated()[1]?.id);
  },
);

it(
  "reports authenticated WebSocket upgrades and keeps old relay connections usable without fabricated reports",
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t);
    const options = {
      servername: f.hostname,
      rejectUnauthorized: false,
      headers: { host: f.hostname, authorization: `Bearer ${f.secret}` },
    };
    const ws = new WebSocket(`wss://127.0.0.1:${f.port}/socket`, options);
    t.after(() => ws.terminate());
    await once(ws, "open");
    await until(() => f.authenticated().length === 1);
    const legacy = await fixture(t, true);
    assert.equal((await legacy.send("/api/auth/login", { token: legacy.secret })).status, 200);
    await delay(20);
    assert.equal(legacy.authenticated().length, 0);
  },
);
