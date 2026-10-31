import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { it, type TestContext } from "node:test";
import { WebSocket } from "ws";
import {
  BROWSER_DEFLATE_THRESHOLD,
  BROWSER_WEBSOCKET_OPTIONS,
  createBrowserWebSocketServer,
} from "../src/browser-websocket.ts";

async function connect(t: TestContext, offerDeflate: boolean) {
  const server = createServer();
  const sockets = createBrowserWebSocketServer();
  const accepted: Promise<WebSocket> = new Promise((resolve) =>
    server.on("upgrade", (request, socket, head) =>
      sockets.handleUpgrade(request, socket, head, resolve),
    ),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    sockets.close();
    server.close();
  });
  const { port } = server.address() as AddressInfo;
  const client = new WebSocket(`ws://127.0.0.1:${String(port)}`, {
    perMessageDeflate: offerDeflate,
  });
  await new Promise((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });
  t.after(() => client.close());
  return { client, peer: await accepted };
}
/** Bytes the client's TCP socket has received, including the upgrade response. */
const received = (client: WebSocket) =>
  (client as unknown as { _socket: { bytesRead: number } })._socket.bytesRead;
async function send(peer: WebSocket, client: WebSocket, payload: string) {
  const before = received(client);
  const message = new Promise<string>((resolve) =>
    client.once("message", (data) => resolve(String(data))),
  );
  peer.send(payload);
  assert.equal(await message, payload);
  return received(client) - before;
}

it("compresses large frames to a browser that offers deflate, keeping the frame limit", async (t) => {
  assert.equal(BROWSER_WEBSOCKET_OPTIONS.maxPayload, 64 * 1024 * 1024);
  assert.equal(typeof BROWSER_WEBSOCKET_OPTIONS.perMessageDeflate, "object");
  const { client, peer } = await connect(t, true);
  assert.match(client.extensions, /permessage-deflate/u);
  const history = JSON.stringify({ output: "tool output line\n".repeat(20_000) });
  const wire = await send(peer, client, history);
  assert.ok(history.length > 300_000);
  assert.ok(wire < history.length / 20, `${String(wire)} wire bytes for ${String(history.length)}`);
});

it("sends frames below the threshold uncompressed and serves browsers without deflate", async (t) => {
  const compressed = await connect(t, true);
  const small = "s".repeat(BROWSER_DEFLATE_THRESHOLD - 64);
  // 2 byte header, no compression: roughly the payload length plus framing.
  const wire = await send(compressed.peer, compressed.client, small);
  assert.ok(wire >= small.length && wire < small.length + 16, String(wire));

  const plain = await connect(t, false);
  assert.equal(plain.client.extensions, "");
  const large = "tool output line\n".repeat(2_000);
  assert.ok((await send(plain.peer, plain.client, large)) >= large.length);
});
