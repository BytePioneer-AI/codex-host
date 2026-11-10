import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import {
  connect as connectHttp2,
  type IncomingHttpHeaders,
  type IncomingHttpStatusHeader,
  type OutgoingHttpHeaders,
} from "node:http2";
import { request as httpRequest } from "node:http";
import { connect, type ConnectionOptions } from "node:tls";
import { it } from "node:test";
import { brotliDecompressSync } from "node:zlib";
import { WebSocket } from "ws";
import { toolOutputRelay } from "./support/tool-output-relay.ts";
import { defined } from "./support/defined.ts";

it(
  "serves authenticated h2 RPC, compressed assets, uploads and live events on one relay connection",
  { timeout: 60_000 },
  async (t) => {
    const cleanup: Array<() => void> = [];
    t.after(() => cleanup.forEach((close) => close()));
    const f = await toolOutputRelay(t);
    let connections = 0;
    f.relay.server.on("connection", () => connections++);
    const session = connectHttp2(f.origin, {
      createConnection: () =>
        connect({
          host: "localhost",
          port: f.relay.port,
          servername: f.hostname,
          ALPNProtocols: ["h2", "http/1.1"],
        }),
    });
    cleanup.push(() => session.destroy());
    await once(session, "connect");
    assert.equal(session.alpnProtocol, "h2");
    const send = (path: string, body?: string | Buffer, headers: OutgoingHttpHeaders = {}) =>
      new Promise<{ headers: IncomingHttpHeaders & IncomingHttpStatusHeader; body: Buffer }>(
        (resolve, reject) => {
          const request = session.request({
            ":path": path,
            ":method": body === undefined ? "GET" : "POST",
            ...headers,
          });
          let reply: IncomingHttpHeaders & IncomingHttpStatusHeader;
          const chunks: Buffer[] = [];
          request.on("response", (headers) => (reply = headers));
          request.on("data", (chunk) => chunks.push(chunk));
          request.on("error", reject);
          request.on("end", () => resolve({ headers: reply, body: Buffer.concat(chunks) }));
          request.end(body);
        },
      );
    const rpc = (method: string, args = {}) =>
      JSON.stringify({ type: "client-request", rpcId: "h2", method, payload: { args } });
    const anonymous = await send("/");
    assert.equal(anonymous.headers[":status"], 401);
    assert.equal(anonymous.headers["strict-transport-security"], "max-age=31536000");
    for (const origin of [`http://${f.hostname}`, "https://sibling.relay.test"]) {
      assert.equal(
        (await send("/api/auth/login", JSON.stringify({ token: f.secret }), { origin })).headers[
          ":status"
        ],
        403,
      );
    }
    const login = await send("/api/auth/login", JSON.stringify({ token: f.secret }), {
      origin: f.origin,
    });
    assert.equal(login.headers[":status"], 200);
    const cookie = defined(login.headers["set-cookie"]?.[0]);
    assert.match(cookie, /^__Host-codexhost_token=.*; Secure$/);
    const auth = { cookie: defined(cookie.split(";")[0]), origin: f.origin };
    const forged = {
      ...auth,
      "x-forwarded-for": "127.0.0.1",
      "x-forwarded-proto": "http",
      "x-forwarded-host": "localhost",
    };
    assert.deepEqual(
      JSON.parse((await send("/api/auth/status", undefined, forged)).body.toString()),
      { authenticated: true, local: false },
    );
    const restricted = await send(
      "/api/codexhost/accessTokenGet",
      rpc("codexhost/accessTokenGet"),
      forged,
    );
    assert.equal(
      JSON.parse(restricted.body.toString()).result.error.code,
      "auth/local-access-required",
    );
    assert.equal(
      (await send("/api/auth/status", undefined, { cookie: `codexhost_token=${f.secret}` }))
        .headers[":status"],
      401,
    );
    assert.equal(
      (await send("/api/auth/login", JSON.stringify({ token: f.localToken }), { origin: f.origin }))
        .headers[":status"],
      401,
    );
    const plain = await send("/", undefined, auth);
    const compressed = await send("/", undefined, { ...auth, "accept-encoding": "br" });
    assert.equal(compressed.headers["content-encoding"], "br");
    assert.deepEqual(brotliDecompressSync(compressed.body), plain.body);

    // Keep an event stream open while other requests and uploads use the session.
    const events = session.request({ ":path": "/api/ch/v1/events", ...auth });
    events.on("error", () => {});
    cleanup.push(() => events.close());
    const first = await once(events, "data");
    assert.match(String(first[0]), /"type":"hello"/);
    events.resume();
    const replies = await Promise.all(
      Array.from({ length: 12 }, () => send("/api/auth/status", undefined, auth)),
    );
    assert.ok(replies.every((reply) => reply.headers[":status"] === 200));
    assert.equal(connections, 1);

    const created = await send(
      "/api/session/create",
      rpc("session/create", { request: { cwd: f.data.root } }),
      auth,
    );
    const id = JSON.parse(created.body.toString()).result.value.sessionId as string;
    assert.ok(id);
    const path = `/api/session/uploadFileBinary?sessionId=${encodeURIComponent(id)}&name=notes.txt`;
    const bytes = Buffer.alloc(256 * 1024, 42);
    assert.equal(
      (
        await send(path, bytes, {
          ...auth,
          origin: "https://evil.test",
          "content-type": "application/octet-stream",
        })
      ).headers[":status"],
      403,
    );
    const uploaded = await send(path, bytes, {
      ...auth,
      "content-type": "application/octet-stream",
    });
    const stored = JSON.parse(uploaded.body.toString());
    assert.equal(stored.ok, true);
    assert.equal(stored.value.file.bytes, bytes.length);
    const prompted = await send(
      "/api/session/prompt",
      rpc("session/prompt", {
        request: {
          sessionId: id,
          content: [
            { type: "file", receiptId: stored.value.receiptId },
            { type: "text", text: "inspect" },
          ],
        },
      }),
      auth,
    );
    assert.equal(JSON.parse(prompted.body.toString()).result.ok, true);
    const prompt = f.host.requests.find((request) => request.method === "turn/start");
    assert.ok(prompt);
    const input = prompt.params.input as Array<{ text: string }>;
    const storedPath = /## notes.txt: (.+)\n/u.exec(input[0]?.text ?? "")?.[1];
    assert.ok(storedPath);
    assert.deepEqual(readFileSync(storedPath), bytes);

    const imagePath = f.data.path("sample.png");
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      "base64",
    );
    writeFileSync(imagePath, png);
    const download = await send(`/api/file?path=${encodeURIComponent(imagePath)}`, undefined, auth);
    assert.equal(download.headers[":status"], 200);
    assert.deepEqual(download.body, png);
    assert.equal(connections, 1);

    const wsOptions = {
      servername: f.hostname,
      ALPNProtocols: ["http/1.1"],
      headers: { ...auth, host: f.hostname },
    } satisfies WebSocket.ClientOptions & Pick<ConnectionOptions, "servername" | "ALPNProtocols">;
    const ws = new WebSocket(`wss://localhost:${f.relay.port}/api/remote.mux`, wsOptions);
    cleanup.push(() => ws.terminate());
    await once(ws, "open");
    const pong = once(ws, "pong");
    ws.ping("h2 alongside h1");
    assert.equal(String((await pong)[0]), "h2 alongside h1");
    assert.equal(connections, 2, "one h2 connection plus one HTTP/1.1 WebSocket");
    ws.close();
    await once(ws, "close");
    events.close();
    assert.equal((await send("/api/auth/logout", "{}", auth)).headers[":status"], 200);

    await new Promise<void>((resolve, reject) => {
      const request = httpRequest(f.local, (response) => {
        assert.equal(response.httpVersion, "1.1");
        response.resume();
        response.once("end", resolve);
      });
      request.on("error", reject);
      request.end();
    });
    t.diagnostic(
      `12 concurrent HTTP requests: ${connections - 1} TLS connection; WebSocket: 1 separate HTTP/1.1 connection`,
    );
  },
);
