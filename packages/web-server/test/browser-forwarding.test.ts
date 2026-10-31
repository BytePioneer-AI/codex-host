import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { it, type TestContext } from "node:test";

import { WebSocket, WebSocketServer } from "ws";

import { ACCESS_COOKIE } from "../src/auth.ts";
import { BrowserForwarding } from "../src/browser-forwarding.ts";

const TOKEN = "forwarding-test-token";
const signedIn = `${ACCESS_COOKIE}=${TOKEN}`;

async function listen(t: TestContext, server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return (server.address() as AddressInfo).port;
}

/** A loopback service that echoes what it received and answers like common dev servers. */
async function startService(t: TestContext): Promise<number> {
  const service = createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { location: `http://localhost:${port}/next?x=1` }).end();
      return;
    }
    response.writeHead(200, {
      "content-type": "application/json",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
      "set-cookie": [
        "session=abc; Domain=localhost; Path=/; Secure; HttpOnly; SameSite=None",
        `${ACCESS_COOKIE}=stolen; Path=/`,
      ],
    });
    response.end(
      JSON.stringify({
        host: request.headers.host,
        origin: request.headers.origin,
        referer: request.headers.referer,
        cookie: request.headers.cookie,
      }),
    );
  });
  const sockets = new WebSocketServer({ server: service });
  sockets.on("connection", (socket, request: IncomingMessage) => {
    socket.send(`origin=${request.headers.origin ?? ""} host=${request.headers.host ?? ""}`);
  });
  const port = await listen(t, service);
  return port;
}

function forwarding(t: TestContext, serverPort = 1): BrowserForwarding {
  const instance = new BrowserForwarding({
    host: "127.0.0.1",
    serverPort: () => serverPort,
    authorized: (request) => (request.headers.cookie ?? "").includes(signedIn),
  });
  t.after(() => instance.close());
  return instance;
}

it("forwards a loopback service to a reusable, authenticated listener origin", async (t) => {
  const service = await startService(t);
  const forwards = forwarding(t);
  const port = await forwards.forward(`http://localhost:${String(service)}/app?q=1`);
  assert.equal(await forwards.forward(`http://localhost:${String(service)}/other`), port);
  assert.notEqual(await forwards.forward(`http://127.0.0.1:${String(service)}/`), port);
  const own = `http://127.0.0.1:${String(port)}`;

  const anonymous = await fetch(`${own}/`);
  assert.equal(anonymous.status, 401);

  const response = await fetch(`${own}/app`, {
    headers: { cookie: `${signedIn}; theme=dark`, origin: own, referer: `${own}/app` },
  });
  assert.equal(response.status, 200);
  const seen = (await response.json()) as Record<string, string | undefined>;
  assert.deepEqual(seen, {
    host: `localhost:${String(service)}`,
    origin: `http://localhost:${String(service)}`,
    referer: `http://localhost:${String(service)}/app`,
    cookie: "theme=dark",
  });
  assert.equal(response.headers.get("x-frame-options"), null);
  assert.equal(response.headers.get("content-security-policy"), "default-src 'self'");
  assert.deepEqual(response.headers.getSetCookie(), [
    "session=abc; Path=/; HttpOnly; SameSite=Lax",
  ]);

  const redirect = await fetch(`${own}/redirect`, {
    headers: { cookie: signedIn },
    redirect: "manual",
  });
  assert.equal(redirect.headers.get("location"), `${own}/next?x=1`);
});

it("forwards WebSocket upgrades with the service's own origin", async (t) => {
  const service = await startService(t);
  const port = await forwarding(t).forward(`http://localhost:${String(service)}/`);
  const own = `http://127.0.0.1:${String(port)}`;
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/hmr`, {
    headers: { cookie: signedIn, origin: own },
  });
  t.after(() => socket.close());
  const message = await new Promise<string>((resolve, reject) => {
    socket.once("message", (data) => resolve(String(data)));
    socket.once("error", reject);
  });
  assert.equal(
    message,
    `origin=http://localhost:${String(service)} host=localhost:${String(service)}`,
  );

  const refused = new WebSocket(`ws://127.0.0.1:${String(port)}/hmr`);
  const status = await new Promise<number>((resolve) =>
    refused.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0)),
  );
  assert.equal(status, 401);
});

it("refuses addresses that are not this machine's loopback or are CodexHost itself", async (t) => {
  const forwards = forwarding(t, 4400);
  for (const url of [
    "https://github.com/",
    "http://192.168.1.10:3000/",
    "file:///etc/hosts",
    "http://user:secret@localhost:3000/",
    "http://localhost:4400/",
  ])
    await assert.rejects(forwards.forward(url), { code: "browser-forward/invalid" }, url);
  const port = await forwards.forward("http://localhost:3999/");
  await assert.rejects(forwards.forward(`http://127.0.0.1:${String(port)}/`), {
    code: "browser-forward/invalid",
  });
});

it("reports a stopped loopback service instead of hanging", async (t) => {
  const unused = createServer();
  const closedPort = await listen(t, unused);
  unused.close();
  const port = await forwarding(t).forward(`http://127.0.0.1:${String(closedPort)}/`);
  const response = await fetch(`http://127.0.0.1:${String(port)}/`, {
    headers: { cookie: signedIn },
  });
  assert.equal(response.status, 502);
  assert.match(await response.text(), /Nothing answered/u);
});
