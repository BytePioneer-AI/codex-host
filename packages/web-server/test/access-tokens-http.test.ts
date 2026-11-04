/** Named tokens through the real Web entry point: sign-in, local access, and immediate revocation. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it, type TestContext } from "node:test";

import {
  SIDEBAR_BROWSER_PATH,
  SIDEBAR_BROWSER_TAB_PARAM,
} from "@codexhost/shared-contracts/sidebar-browser";
import WebSocket from "ws";

import { AccessTokenStore } from "../src/access-tokens.ts";
import { DataDir } from "../src/store.ts";
import { FakeChChannel, startFakeChChannel } from "./support/ch-channel.ts";
import { FakeChHost, startFakeChDebugger } from "./support/ch-host.ts";
import { PNG } from "./support/image.ts";
import { startServer } from "./support/server.ts";

const LOCAL_TOKEN = "local-token-for-http-tests";

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** `fetch` cannot set Host, which is exactly what these checks vary. */
function send(
  base: URL,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  return new Promise((done, fail) => {
    const request = httpRequest(
      new URL(path, base),
      // `agent: false` connects directly, so no proxy configured on the machine sees LAN addresses.
      { method: options.method ?? "GET", headers: options.headers ?? {}, agent: false },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () =>
          done({ status: response.statusCode ?? 0, headers: response.headers, body }),
        );
      },
    );
    request.on("error", fail);
    request.end(options.body);
  });
}

function rpcCall(
  base: URL,
  method: string,
  args: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<Reply> {
  return send(base, `/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ type: "client-request", rpcId: "t", method, payload: { args } }),
  });
}

interface RpcResult {
  ok: boolean;
  value?: Record<string, never>;
  error?: { code: string; details: { url?: string } };
}

const resultOf = (reply: Reply): RpcResult =>
  (JSON.parse(reply.body) as { result: RpcResult }).result;

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

async function start(
  t: TestContext,
  args: string[] = [],
): Promise<{ base: URL; data: string; createToken(name: string): Promise<CreatedToken> }> {
  const data = mkdtempSync(join(tmpdir(), "codexhost-auth-http-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const url = await startServer(
    t,
    resolve(import.meta.dirname, ".."),
    ["--import", "tsx", "src/main.ts"],
    ["--data", data, "--token", LOCAL_TOKEN, ...args],
    { authenticated: true },
  );
  const base = new URL(url);
  base.search = "";
  return {
    base,
    data,
    createToken: async (name) => {
      const result = resultOf(
        await rpcCall(base, "codexhost/accessTokenCreate", { name }, bearer(LOCAL_TOKEN)),
      );
      assert.equal(result.ok, true, JSON.stringify(result));
      return result.value as unknown as CreatedToken;
    },
  };
}

interface CreatedToken {
  token: { id: string; name: string };
  secret: string;
  links: Array<{ kind: string; url: string }>;
}

it("signs in with links, cookies, and bearer tokens, keeping named tokens out of URLs", async (t) => {
  const { base, createToken } = await start(t);
  const { secret } = await createToken("phone");
  const remote = { host: "phone.example" };

  const anonymous = await send(base, "/");
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.body, /Access token/u);
  assert.match(anonymous.body, /#token=/u);
  assert.equal(anonymous.headers["set-cookie"], undefined);
  assert.equal(anonymous.headers["x-content-type-options"], "nosniff");
  assert.match(
    (await send(base, "/", { headers: { "accept-language": "zh-CN" } })).body,
    /访问令牌/u,
  );
  assert.equal((await send(base, "/api/auth/status")).status, 401);
  assert.equal((await send(base, "/manifest.webmanifest")).status, 200);

  // Local link: the local token signs in through the query string, on this computer only.
  const local = await send(base, `/?token=${LOCAL_TOKEN}&session=s`);
  assert.equal(local.status, 302);
  assert.equal(local.headers.location, "/?session=s");
  assert.match(String(local.headers["set-cookie"]), /HttpOnly; SameSite=Lax/u);
  assert.doesNotMatch(String(local.headers["set-cookie"]), /Secure/u);

  // The local token is an invalid token anywhere else.
  for (const headers of [remote, { "x-forwarded-for": "198.51.100.1" }]) {
    const link = await send(base, `/?token=${LOCAL_TOKEN}`, { headers });
    assert.equal(link.status, 401);
    assert.equal(link.headers["set-cookie"], undefined);
    assert.equal(
      (await send(base, "/api/auth/status", { headers: { ...bearer(LOCAL_TOKEN), ...headers } }))
        .status,
      401,
    );
    const login = await send(base, "/api/auth/login", {
      method: "POST",
      headers,
      body: JSON.stringify({ token: LOCAL_TOKEN }),
    });
    assert.equal(login.status, 401);
  }

  // A named token in the query string is invalid even on this computer.
  const queried = await send(base, `/?token=${secret}`);
  assert.equal(queried.status, 401);
  assert.equal(queried.headers["set-cookie"], undefined);
  assert.match(queried.body, /not valid here/u);

  // Login from any address, with the cookie then good for documents and the status probe.
  const login = await send(base, "/api/auth/login", {
    method: "POST",
    headers: remote,
    body: JSON.stringify({ token: secret }),
  });
  assert.equal(login.status, 200);
  const cookie = String(login.headers["set-cookie"]);
  assert.match(cookie, /HttpOnly; SameSite=Lax/u);
  const cookieHeader = { cookie: cookie.split(";")[0] as string };
  const home = await send(base, "/", { headers: { ...cookieHeader, ...remote } });
  assert.equal(home.status, 200);
  assert.match(home.body, /<head><script>.*#token=/su);
  assert.equal(home.headers["x-content-type-options"], "nosniff");
  const status = await send(base, "/api/auth/status", { headers: { ...cookieHeader, ...remote } });
  assert.deepEqual(JSON.parse(status.body), { authenticated: true, local: false });
  assert.deepEqual(
    JSON.parse((await send(base, "/api/auth/status", { headers: bearer(secret) })).body),
    { authenticated: true, local: true },
  );

  const rejected = await send(base, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ token: "not-a-token" }),
  });
  assert.equal(rejected.status, 401);
  assert.equal(rejected.headers["set-cookie"], undefined);
  const crossOrigin = await send(base, "/api/auth/login", {
    method: "POST",
    headers: { origin: "https://elsewhere.example" },
    body: JSON.stringify({ token: secret }),
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal(
    (
      await send(base, "/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ token: "x".repeat(8192) }),
      })
    ).status,
    413,
  );

  // A cookie that stopped being valid is cleared so it is not counted again.
  const expired = await send(base, "/", { headers: { cookie: "codexhost_token=gone" } });
  assert.equal(expired.status, 401);
  assert.match(String(expired.headers["set-cookie"]), /codexhost_token=; .*Max-Age=0/u);
  assert.equal(
    (await send(base, "/assets/missing.js", { headers: { cookie: "codexhost_token=gone" } }))
      .headers["set-cookie"],
    undefined,
  );
});

it("offers management only to local access", async (t) => {
  const { base, createToken } = await start(t);
  const { secret, token } = await createToken("phone");
  const list = (headers: Record<string, string>) =>
    rpcCall(base, "codexhost/accessTokenList", {}, headers);

  const listed = resultOf(await list(bearer(secret)));
  assert.equal(listed.ok, true);
  assert.deepEqual(
    (listed.value as unknown as { tokens: Array<{ name: string }> }).tokens.map(({ name }) => name),
    ["phone"],
  );
  assert.equal(
    (listed.value as unknown as { tokens: Array<{ secret: string }> }).tokens[0]?.secret,
    secret,
  );

  for (const headers of [
    { ...bearer(secret), host: "phone.example" },
    { ...bearer(secret), "x-forwarded-for": "198.51.100.1" },
    { ...bearer(secret), "x-forwarded-host": "127.0.0.1" },
  ]) {
    for (const reply of [
      await list(headers),
      await rpcCall(base, "codexhost/accessTokenCreate", { name: "new" }, headers),
      await rpcCall(base, "codexhost/accessTokenDelete", { id: token.id }, headers),
    ]) {
      assert.equal(reply.body.includes("phone"), false);
      assert.equal(reply.body.includes(secret), false);
      const result = resultOf(reply);
      assert.equal(result.ok, false);
      assert.equal(result.error?.code, "auth/local-access-required");
      assert.equal(result.error?.details.url, `http://127.0.0.1:${base.port}`);
    }
  }
  const after = resultOf(await list(bearer(LOCAL_TOKEN)));
  assert.equal((after.value as unknown as { tokens: unknown[] }).tokens.length, 1);

  const invalid = resultOf(
    await rpcCall(base, "codexhost/accessTokenCreate", { name: "  " }, bearer(LOCAL_TOKEN)),
  );
  assert.equal(invalid.error?.code, "auth/invalid-token-name");
  const duplicate = resultOf(
    await rpcCall(base, "codexhost/accessTokenCreate", { name: "phone" }, bearer(LOCAL_TOKEN)),
  );
  assert.equal(duplicate.error?.code, "auth/duplicate-token-name");
  const missing = resultOf(
    await rpcCall(base, "codexhost/accessTokenDelete", { id: "unknown" }, bearer(LOCAL_TOKEN)),
  );
  assert.deepEqual(missing.value, { deleted: false });

  // Deleting the token this very request used still reports the result.
  const own = resultOf(
    await rpcCall(base, "codexhost/accessTokenDelete", { id: token.id }, bearer(secret)),
  );
  assert.deepEqual(own.value, { deleted: true });
  assert.equal((await send(base, "/api/auth/status", { headers: bearer(secret) })).status, 401);
});

it("gives network sign-in links without the local token only when listening on the network", async (t) => {
  const networked = await start(t, ["--host", "0.0.0.0"]);
  const created = await networked.createToken("phone");
  const listed = resultOf(
    await rpcCall(networked.base, "codexhost/accessTokenList", {}, bearer(LOCAL_TOKEN)),
  ).value as unknown as { networkUrls: Array<{ url: string }> };
  assert.equal(created.links.length, listed.networkUrls.length);
  for (const link of created.links) assert.match(link.url, /^http:\/\/[^/]+\/#token=/u);
  assert.equal(JSON.stringify(created.links).includes(LOCAL_TOKEN), false);
  assert.equal(JSON.stringify(listed.networkUrls).includes("token"), false);

  // Through a real network address (when this machine has one) nothing counts as local.
  const address = listed.networkUrls[0]?.url;
  if (address !== undefined) {
    const lan = new URL(address);
    assert.deepEqual(
      JSON.parse((await send(lan, "/api/auth/status", { headers: bearer(created.secret) })).body),
      { authenticated: true, local: false },
    );
    assert.equal(
      (await send(lan, "/api/auth/status", { headers: bearer(LOCAL_TOKEN) })).status,
      401,
    );
    assert.equal(
      resultOf(await rpcCall(lan, "codexhost/accessTokenList", {}, bearer(created.secret))).error
        ?.code,
      "auth/local-access-required",
    );
  }

  const loopback = await start(t);
  assert.deepEqual((await loopback.createToken("phone")).links, []);
});

it("trusts forwarding headers only from a configured proxy", async (t) => {
  const forged = {
    origin: "https://phone.example",
    "x-forwarded-host": "phone.example",
    "x-forwarded-proto": "https",
  };
  const untrusted = await start(t);
  const { secret } = await untrusted.createToken("phone");
  assert.equal(
    (
      await send(untrusted.base, "/api/auth/login", {
        method: "POST",
        headers: forged,
        body: JSON.stringify({ token: secret }),
      })
    ).status,
    403,
  );

  const proxied = await start(t, ["--trusted-proxy", "127.0.0.1"]);
  const named = await proxied.createToken("phone");
  const login = await send(proxied.base, "/api/auth/login", {
    method: "POST",
    headers: forged,
    body: JSON.stringify({ token: named.secret }),
  });
  assert.equal(login.status, 200);
  assert.match(String(login.headers["set-cookie"]), /; Secure$/u);
  // Trusting a proxy does not make what it forwards local.
  assert.equal(
    resultOf(
      await rpcCall(
        proxied.base,
        "codexhost/accessTokenList",
        {},
        { ...bearer(named.secret), "x-forwarded-for": "198.51.100.1" },
      ),
    ).error?.code,
    "auth/local-access-required",
  );

  // Failures count per forwarded client, so one client cannot lock out another.
  const attempt = (client: string, token = "wrong-token") =>
    send(proxied.base, "/api/auth/login", {
      method: "POST",
      headers: { "x-forwarded-for": client },
      body: JSON.stringify({ token }),
    });
  for (let failure = 0; failure < 10; failure += 1)
    assert.equal((await attempt("198.51.100.1")).status, 401);
  assert.equal((await attempt("198.51.100.1")).status, 429);
  assert.equal((await attempt("198.51.100.1", named.secret)).status, 429);
  assert.equal((await attempt("198.51.100.2", named.secret)).status, 200);
});

it("limits failed tokens by address without affecting signed-in devices", async (t) => {
  const { base, createToken } = await start(t);
  const { secret } = await createToken("phone");
  const wrong = { cookie: "codexhost_token=wrong" };
  // Public assets neither count nor get limited.
  for (let request = 0; request < 12; request += 1) {
    assert.equal((await send(base, "/manifest.webmanifest", { headers: wrong })).status, 200);
  }
  for (let failure = 0; failure < 9; failure += 1) {
    assert.equal((await send(base, "/api/auth/status", { headers: bearer("wrong") })).status, 401);
  }
  const upgradeStatus = async (): Promise<number> => {
    const socket = new WebSocket(new URL("/api/remote.mux", base), { headers: bearer("wrong") });
    socket.on("error", () => undefined);
    const [, refused] = (await once(socket, "unexpected-response")) as [
      unknown,
      { statusCode: number },
    ];
    socket.terminate();
    return refused.statusCode;
  };
  assert.equal(await upgradeStatus(), 401);

  const login = await send(base, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ token: "wrong" }),
  });
  assert.equal(login.status, 429);
  assert.equal(JSON.parse(login.body).error.code, "auth/rate-limited");
  assert.equal((await send(base, "/api/auth/status", { headers: bearer("wrong") })).status, 429);
  const page = await send(base, "/", { headers: wrong });
  assert.equal(page.status, 429);
  assert.match(page.body, /Too many attempts/u);
  assert.match(String(page.headers["set-cookie"]), /Max-Age=0/u);
  assert.equal(await upgradeStatus(), 429);

  // Valid credentials are never limited, and neither is simply not being signed in yet.
  assert.equal((await send(base, "/api/auth/status", { headers: bearer(secret) })).status, 200);
  assert.equal(
    (await send(base, "/api/auth/status", { headers: bearer(LOCAL_TOKEN) })).status,
    200,
  );
  assert.equal((await send(base, "/")).status, 401);
});

it("refuses management and keeps push subscriptions working with authentication off", async (t) => {
  const debug = await startFakeChDebugger(new FakeChHost());
  t.after(() => debug.close());
  const url = await startServer(
    t,
    resolve(import.meta.dirname, ".."),
    ["--import", "tsx", "src/main.ts"],
    ["--ch-cdp", debug.endpoint],
  );
  const base = new URL(url);
  assert.equal(
    resultOf(await rpcCall(base, "codexhost/accessTokenList", {}, {})).error?.code,
    "auth/disabled",
  );
  const subscribed = resultOf(
    await rpcCall(
      base,
      "codexhost/pushSubscribe",
      { subscription: { endpoint: "https://push.test/a", keys: { p256dh: "p", auth: "a" } } },
      {},
    ),
  );
  assert.equal(subscribed.ok, true, JSON.stringify(subscribed));
  assert.equal((await send(base, "/")).body.includes("#token="), false);
});

it("serves only raster images from local files", async (t) => {
  const { base } = await start(t);
  const directory = mkdtempSync(join(tmpdir(), "codexhost-auth-files-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const png = join(directory, "image.png");
  writeFileSync(png, Buffer.from(PNG, "base64"));
  const file = (path: string) =>
    send(base, `/api/file?path=${encodeURIComponent(path)}`, { headers: bearer(LOCAL_TOKEN) });
  const image = await file(png);
  assert.equal(image.status, 200);
  assert.equal(image.headers["x-content-type-options"], "nosniff");
  assert.equal(image.headers["content-type"], "image/png");
  for (const [name, content] of [
    ["page.html", "<script>alert(1)</script>"],
    ["image.svg", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
    // A misleading name does not make a document an image.
    ["page.png", "<html><script>alert(1)</script></html>"],
  ] as const) {
    const path = join(directory, name);
    writeFileSync(path, content);
    const reply = await file(path);
    assert.equal(reply.status, 404, name);
    assert.equal(reply.body.includes("<script>"), false, name);
  }
});

it(
  "closes every connection of a deleted token at once, leaving others and running work alone",
  { timeout: 60_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "codexhost-auth-revoke-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const workspace = join(directory, "workspace");
    mkdirSync(workspace);
    const host = new FakeChChannel();
    host.add("local-thread", workspace, "Local Thread");
    const debug = await startFakeChDebugger(host);
    t.after(() => debug.close());
    const channel = await startFakeChChannel(host, directory);
    t.after(() => channel.close());
    const { base, createToken, data } = await start(t, [
      "--ch-cdp",
      debug.endpoint,
      "--ch-control-directory",
      directory,
    ]);
    const a = await createToken("a");
    const b = await createToken("b");

    const openSockets = async (secret: string) => {
      const sockets = [
        new WebSocket(new URL("/api/remote.mux", base), { headers: bearer(secret) }),
        new WebSocket(
          new URL(`${SIDEBAR_BROWSER_PATH}?${SIDEBAR_BROWSER_TAB_PARAM}=revoke-tab`, base),
          { headers: bearer(secret) },
        ),
      ];
      await Promise.all(sockets.map((socket) => once(socket, "open")));
      return sockets;
    };
    const socketsA = await openSockets(a.secret);
    const socketsB = await openSockets(b.secret);
    t.after(() => {
      for (const socket of [...socketsA, ...socketsB]) socket.terminate();
    });
    // The event stream sends no headers until an event arrives, so it stays in flight.
    const inFlight = new Promise<void>((settled) => {
      const request = httpRequest(new URL("/api/ch/v1/events", base), {
        headers: bearer(a.secret),
      });
      request.on("error", () => settled());
      request.on("response", (response) => {
        response.on("close", () => settled());
        response.resume();
      });
      request.end();
    });
    await new Promise((settled) => setTimeout(settled, 300));

    const terminal = resultOf(
      await rpcCall(
        base,
        "terminal/create",
        { agentId: "local-thread", request: { id: "term", cols: 80, rows: 24 } },
        bearer(a.secret),
      ),
    );
    assert.equal(terminal.ok, true, JSON.stringify(terminal));

    const attachedToTerminal = (socket: WebSocket): Promise<boolean> =>
      new Promise((done) => {
        const streamId = `attach-${String(Math.random())}`;
        const timer = setTimeout(() => done(false), 10_000);
        socket.on("message", (data) => {
          const frame = JSON.parse(String(data)) as {
            streamId?: string;
            value?: { type?: string };
          };
          if (frame.streamId !== streamId || frame.value?.type !== "snapshot") return;
          clearTimeout(timer);
          done(true);
        });
        socket.send(
          JSON.stringify({
            type: "open",
            streamId,
            endpoint: "terminal/attach",
            payload: { args: { agentId: "local-thread", id: "term" } },
          }),
        );
      });
    assert.equal(await attachedToTerminal(socketsA[0] as WebSocket), true);

    const closedA = socketsA.map((socket) => once(socket, "close"));
    const deleted = resultOf(
      await rpcCall(base, "codexhost/accessTokenDelete", { id: a.token.id }, bearer(LOCAL_TOKEN)),
    );
    assert.deepEqual(deleted.value, { deleted: true });
    await Promise.all(closedA);
    await inFlight;
    assert.equal((await send(base, "/api/auth/status", { headers: bearer(a.secret) })).status, 401);
    for (const socket of socketsB) assert.equal(socket.readyState, WebSocket.OPEN);
    assert.equal((await send(base, "/api/auth/status", { headers: bearer(b.secret) })).status, 200);

    // The terminal that token opened keeps running for whoever is still allowed in.
    assert.equal(await attachedToTerminal(socketsB[0] as WebSocket), true);
    assert.equal(
      host.requests.some(({ method }) => /interrupt|cancel|archive/iu.test(method)),
      false,
    );

    // Deleted by another process sharing the data directory: new requests fail at once,
    // and connections close within the removal check interval.
    const other = new AccessTokenStore(new DataDir(data));
    t.after(() => other.close());
    const closedB = socketsB.map((socket) => once(socket, "close"));
    const started = Date.now();
    assert.equal(other.delete(b.token.id), true);
    assert.equal((await send(base, "/api/auth/status", { headers: bearer(b.secret) })).status, 401);
    await Promise.all(closedB);
    assert.ok(Date.now() - started < 7_000);
  },
);
