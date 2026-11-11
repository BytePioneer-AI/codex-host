import assert from "node:assert/strict";
import { once } from "node:events";
import { copyFileSync, mkdirSync } from "node:fs";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { request } from "node:https";
import { resolve } from "node:path";
import { connect, type ConnectionOptions } from "node:tls";
import { it, type TestContext } from "node:test";
import { WebSocket } from "ws";
import type { WebAccessState } from "@codexhost/shared-contracts";
import { relayIdentity } from "../src/remote-relay/identity.ts";
import { certPath, delay, keyPath, relayData, startRelay } from "./support/relay.ts";
import { defined } from "./support/defined.ts";
import { startServer } from "./support/server.ts";
import { acmeServer } from "./support/acme-server.ts";

const ciTiming = { skip: process.env.CI ? "timing-sensitive under CI load" : false };

async function fixture(t: TestContext, certificate = true) {
  const ca = await acmeServer(t, ({ reply }) => {
    reply(503, { detail: "test CA unavailable" });
    return true;
  });
  const relay = await startRelay(t);
  const data = relayData(t);
  const hostname = `${relayIdentity(data).id}.relay.test`;
  if (certificate) {
    const endpoint = `remote-relay/endpoints/${encodeURIComponent(`localhost:${relay.port}`)}`;
    mkdirSync(data.path(endpoint), { recursive: true });
    copyFileSync(certPath, data.path(endpoint, "certificate.pem"));
    copyFileSync(keyPath, data.path("remote-relay/certificate-key.pem"));
  }
  data.writeJson("service.json", { relayHost: `localhost:${relay.port}`, relayEnabled: true });
  const local = new URL(
    await startServer(
      t,
      resolve(import.meta.dirname, ".."),
      ["--import", "tsx", "src/main.ts"],
      ["--data", data.root],
      {
        authenticated: true,
        environment: {
          NODE_EXTRA_CA_CERTS: certPath,
          HTTPS_PROXY: "",
          https_proxy: "",
          CODEXHOST_RELAY_ACME_DIRECTORY: ca.directory,
        },
      },
    ),
  );
  const localToken = defined(local.searchParams.get("token") ?? undefined);
  const body = (method: string, args = {}) =>
    JSON.stringify({ type: "client-request", rpcId: "test", method, payload: { args } });
  const access = async (): Promise<WebAccessState> => {
    const response = await fetch(new URL("/api/codexhost/accessTokenGet", local), {
      method: "POST",
      headers: { authorization: `Bearer ${localToken}` },
      body: body("codexhost/accessTokenGet"),
    });
    return (await response.json()).result.value;
  };
  let state = await access();
  for (let i = 0; state.relay?.state.status === "connecting" && i < 100; i++) {
    await delay(20);
    state = await access();
  }
  assert.equal(state.relay?.state.status, certificate ? "connected" : "missing-certificate");
  const options = (path: string, headers = {}, ip = "::1") => ({
    hostname: ip,
    port: relay.port,
    servername: hostname,
    path,
    agent: false as const,
    headers: { host: hostname, ...headers },
    ALPNProtocols: ["http/1.1"],
  });
  const send = (path: string, payload?: string, headers = {}, ip = "::1") =>
    new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>(
      (resolve, reject) => {
        const req = request(
          { ...options(path, headers, ip), method: payload === undefined ? "GET" : "POST" },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("error", reject);
            response.on("end", () =>
              resolve({
                status: defined(response.statusCode),
                headers: response.headers,
                body: Buffer.concat(chunks),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end(payload);
      },
    );
  return { relay, hostname, state, local, localToken, options, send, body, access };
}

it("terminates real phone TLS for login, RPC and WebSocket, with relay trust and secure cookies", async (t) => {
  const f = await fixture(t);
  const alpn = connect({
    host: "localhost",
    port: f.relay.port,
    servername: f.hostname,
    ALPNProtocols: ["h2", "http/1.1"],
  });
  t.after(() => alpn.destroy());
  await once(alpn, "secureConnect");
  assert.equal(alpn.alpnProtocol, "h2");
  alpn.end();
  const anonymous = await f.send("/");
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers["strict-transport-security"], "max-age=31536000");
  assert.equal(anonymous.headers["content-security-policy"], "frame-ancestors 'self'");
  assert.equal(anonymous.headers["alt-svc"], undefined);
  const direct = await fetch(f.local, { redirect: "manual" });
  assert.equal(direct.headers.get("content-security-policy"), "frame-ancestors 'self'");
  assert.equal(direct.headers.get("strict-transport-security"), null);
  const login = await f.send("/api/auth/login", JSON.stringify({ token: f.state.secret }), {
    origin: `https://${f.hostname}`,
  });
  assert.equal(login.status, 200);
  const cookie = defined(login.headers["set-cookie"]?.[0]);
  assert.match(cookie, /^__Host-codexhost_token=/);
  assert.match(cookie, /; Path=\/; HttpOnly; SameSite=Lax; Max-Age=31536000; Secure$/);
  assert.doesNotMatch(cookie, /Domain=/i);
  const auth = { cookie: defined(cookie.split(";")[0]) };
  assert.equal((await f.send("/", undefined, auth)).status, 200);
  assert.equal(
    (await f.send("/api/auth/status", undefined, { cookie: `codexhost_token=${f.state.secret}` }))
      .status,
    401,
  );
  const config = await f.send("/api/codexhost/pushConfig", f.body("codexhost/pushConfig"), auth);
  assert.equal(JSON.parse(config.body.toString()).result.ok, true);
  const status = await f.send("/api/auth/status", undefined, auth);
  assert.deepEqual(JSON.parse(status.body.toString()), { authenticated: true, local: false });
  const forged = {
    ...auth,
    "x-forwarded-for": "127.0.0.1",
    "x-forwarded-proto": "http",
    "x-forwarded-host": "evil.localhost",
  };
  for (const method of ["codexhost/accessTokenGet", "codexhost/relaySet"]) {
    const reply = await f.send(`/api/${method}`, f.body(method, { enabled: false }), forged);
    assert.equal(JSON.parse(reply.body.toString()).result.error.code, "auth/local-access-required");
  }
  for (const origin of [`http://${f.hostname}`, "https://sibling.localhost"]) {
    assert.equal(
      (await f.send("/api/auth/login", JSON.stringify({ token: f.state.secret }), { origin }))
        .status,
      403,
    );
    assert.equal((await f.send("/api/test", f.body("test"), { ...auth, origin })).status, 403);
  }
  // ws forwards SNI to tls.connect, but ClientOptions omits servername.
  const wsOptions = {
    servername: f.hostname,
    headers: { ...auth, host: f.hostname, origin: `https://${f.hostname}` },
  } satisfies WebSocket.ClientOptions & Pick<ConnectionOptions, "servername">;
  const ws = new WebSocket(`wss://localhost:${f.relay.port}/api/remote.mux`, wsOptions);
  t.after(() => ws.terminate());
  await once(ws, "open");
  const pong = once(ws, "pong");
  ws.ping("phone");
  assert.equal(String((await pong)[0]), "phone");
  ws.close();
  await once(ws, "close");
  const logout = await f.send("/api/auth/logout", "{}", auth);
  assert.match(
    defined(logout.headers["set-cookie"]?.[0]),
    /^__Host-codexhost_token=; .*Max-Age=0; Secure$/,
  );
});

it("limits by Relay's phone IP, ignores forged forwarding headers, and keeps another phone usable", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 10; i++) {
    const result = await f.send("/api/auth/login", JSON.stringify({ token: "wrong" }), {
      "x-forwarded-for": `198.51.100.${i}`,
    });
    assert.equal(result.status, 401);
  }
  assert.equal(
    (
      await f.send("/api/auth/login", JSON.stringify({ token: f.state.secret }), {
        "x-forwarded-for": "127.0.0.1",
      })
    ).status,
    429,
  );
  assert.equal(
    (await f.send("/api/auth/login", JSON.stringify({ token: f.state.secret }), {}, "127.0.0.1"))
      .status,
    200,
  );
});

it("resets phones when certificates are missing but keeps registration", ciTiming, async (t) => {
  const f = await fixture(t, false);
  assert.equal(
    f.state.networkUrls.some((entry) => entry.kind === "relay"),
    false,
  );
  await assert.rejects(f.send("/"));
  assert.equal((await f.access()).relay?.state.status, "missing-certificate");
});

it("drains a large response without blocking a second phone's RPC", ciTiming, async (t) => {
  const f = await fixture(t);
  const auth = { authorization: `Bearer ${f.state.secret}` };
  const page = (await f.send("/", undefined, auth)).body.toString();
  const plugin = [...page.matchAll(/(?:src|href)="([^"\s]*plugins\/[^"\s]+)"/g)]
    .map((match) => defined(match[1]))
    .sort((a, b) => b.length - a.length)[0];
  assert.ok(plugin, "shell includes a plugin batch");
  const url = new URL(plugin.replaceAll("&amp;", "&"), "https://local/");
  const path = url.pathname + url.search;
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const req = request(f.options(path, auth), resolve);
    req.on("error", reject);
    req.end();
  });
  t.after(() => response.destroy());
  response.pause();
  await delay(100);
  const started = performance.now();
  const rpc = await f.send(
    "/api/codexhost/pushConfig",
    f.body("codexhost/pushConfig"),
    auth,
    "127.0.0.1",
  );
  assert.equal(JSON.parse(rpc.body.toString()).result.ok, true);
  assert.ok(performance.now() - started < 2_000);
  const chunks: Buffer[] = [];
  response.on("data", (chunk) => chunks.push(chunk));
  response.resume();
  await once(response, "end");
  const downloaded = Buffer.concat(chunks);
  assert.ok(downloaded.length > 2 * 1024 * 1024);
  const plain = await fetch(new URL(path, f.local), {
    headers: { authorization: `Bearer ${f.localToken}` },
  });
  assert.deepEqual(downloaded, Buffer.from(await plain.arrayBuffer()));
});
