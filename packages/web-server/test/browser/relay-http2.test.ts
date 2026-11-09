import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { it } from "node:test";
import { chromium, type Browser } from "playwright";
import { toolOutputRelay } from "../support/tool-output-relay.ts";

it(
  "uses one browser h2 connection for concurrent relay requests and HTTP/1.1 for WebSocket",
  { timeout: 60_000 },
  async (t) => {
    let browser: Browser | undefined;
    const sockets = new Set<Socket>();
    const proxy = createServer();
    // Close browser transports before the relay fixture's async shutdown hooks.
    t.after(async () => {
      await browser?.close();
      for (const socket of sockets) socket.destroy();
      proxy.close();
    });
    const f = await toolOutputRelay(t);
    proxy.on("connect", (_request, client, head) => {
      const upstream = connect(f.relay.port, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.write(head);
        client.pipe(upstream).pipe(client);
      });
      sockets.add(upstream);
      upstream.once("close", () => {
        sockets.delete(upstream);
        client.destroy();
      });
      client.once("close", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const results: number[] = [];
    for (const http2 of [false, true]) {
      browser = await chromium.launch({
        proxy: { server: `http://127.0.0.1:${(proxy.address() as { port: number }).port}` },
        args: http2 ? [] : ["--disable-http2"],
      });
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width: 390, height: 844 },
      });
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send("Network.enable");
      const responses: Array<{ protocol?: string; connectionId: number }> = [];
      const idleConnection = Promise.withResolvers<number>();
      let websocketStatus: number | undefined;
      cdp.on("Network.responseReceived", ({ response }) => {
        if (response.url.includes("?reuse=")) responses.push(response);
        if (response.url.includes("?idle=")) idleConnection.resolve(response.connectionId);
      });
      cdp.on(
        "Network.webSocketHandshakeResponseReceived",
        ({ response }) => (websocketStatus = response.status),
      );
      // A same-origin document without loading the full application or its extra requests.
      await page.goto(`${f.origin}/api/auth/status`);
      const login = await page.evaluate(async (token) => {
        const response = await fetch("/api/auth/login", {
          method: "POST",
          body: JSON.stringify({ token }),
        });
        return response.status;
      }, f.secret);
      assert.equal(login, 200);
      const replies = await page.evaluate(async () =>
        Promise.all(
          Array.from({ length: 12 }, async (_, i) => {
            const response = await fetch(`/api/auth/status?reuse=${i}`);
            return { status: response.status, body: await response.json() };
          }),
        ),
      );
      assert.ok(
        replies.every(
          (reply) => reply.status === 200 && reply.body.authenticated && !reply.body.local,
        ),
      );
      assert.equal(responses.length, 12);
      assert.ok(responses.every((response) => response.protocol === (http2 ? "h2" : "http/1.1")));
      const connections = new Set(responses.map((response) => response.connectionId));
      results.push(connections.size);
      if (http2) {
        assert.equal(connections.size, 1);
        await page.waitForTimeout(6_200);
        assert.equal(
          await page.evaluate(async () => (await fetch("/api/auth/status?idle=1")).status),
          200,
        );
        assert.ok(connections.has(await idleConnection.promise));
        const message = await page.evaluate(
          () =>
            new Promise<string>((resolve, reject) => {
              const socket = new WebSocket(`wss://${location.host}/api/remote.mux`);
              socket.onopen = () =>
                socket.send(JSON.stringify({ type: "ping", streamId: "browser-h2" }));
              socket.onerror = () => reject(new Error("WebSocket failed"));
              socket.onmessage = (event) => {
                resolve(String(event.data));
                socket.close();
              };
            }),
        );
        assert.equal(websocketStatus, 101);
        assert.deepEqual(JSON.parse(message), { type: "pong", streamId: "browser-h2" });
      } else {
        assert.ok(
          connections.size > 1,
          "HTTP/1.1 baseline needs multiple connections for concurrent requests",
        );
      }
      await browser.close();
      browser = undefined;
    }
    t.diagnostic(
      `12 concurrent browser HTTP requests: forced HTTP/1.1=${results[0]} connections, h2=${results[1]} connection`,
    );
  },
);
