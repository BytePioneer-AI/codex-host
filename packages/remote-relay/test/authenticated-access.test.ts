import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { IncomingHttpHeaders, ServerHttp2Stream } from "node:http2";
import { createServer as createTlsServer } from "node:tls";
import { expect, it } from "vitest";
import { createRelay } from "../src/index.js";
import type { ConnectionEvent } from "../src/events.js";
import { headers, paths } from "../src/protocol.js";
import { certPath, credentials, delay, fakeAgent, keyPath, phone } from "./helpers.js";

it("binds authentication reports to live non-ACME connections owned by the signed computer", async () => {
  const events: ConnectionEvent[] = [];
  const relay = createRelay({
    domain: "relay.test",
    controlHost: "relay.test",
    cert: certPath,
    key: keyPath,
    onConnection: (event) => events.push(event),
  });
  relay.server.listen(0, "127.0.0.1");
  await once(relay.server, "listening");
  const port = (relay.server.address() as AddressInfo).port;
  const target = createTlsServer(credentials, (socket) => {
    socket.on("error", () => {});
    socket.resume();
  });
  const peers: { stream: ServerHttp2Stream; request: IncomingHttpHeaders }[] = [];
  const sockets: ReturnType<typeof phone>[] = [];
  const agent = () =>
    fakeAgent({
      port,
      tcp: (stream, request) => {
        peers.push({ stream, request });
        target.emit("connection", stream);
      },
    });
  const push = (peer: (typeof peers)[number], id: string, body = "", status = body ? 200 : 204) =>
    new Promise<void>((resolve, reject) => {
      peer.stream.pushStream(
        { ":method": "GET", ":path": paths.authenticated, [headers.connectionId]: id },
        (error, report) => {
          if (error) return reject(error);
          report.on("error", () => {});
          report.respond({ ":status": status });
          report.end(body);
          resolve();
        },
      );
    });
  const authenticated = () =>
    events.filter((event) => event.type === "phone" && event.state === "authenticated");
  try {
    const first = await agent();
    const hostname = await first.registered;
    const socket = phone(hostname, undefined, port);
    sockets.push(socket);
    await once(socket, "secureConnect");
    const firstPeer = peers[0];
    assert.ok(firstPeer);
    const id = String(firstPeer.request[headers.connectionId]);
    await push(firstPeer, "unknown-id");
    await push(firstPeer, id, "invalid payload");
    await push(firstPeer, id, "", 200);
    await delay(20);
    expect(authenticated()).toHaveLength(0);
    const second = await agent();
    const secondPhone = phone(await second.registered, undefined, port);
    sockets.push(secondPhone);
    await once(secondPhone, "secureConnect");
    const secondPeer = peers[1];
    assert.ok(secondPeer);
    await push(secondPeer, id);
    await delay(20);
    expect(authenticated()).toHaveLength(0);
    await push(firstPeer, id);
    await push(firstPeer, id);
    await delay(20);
    expect(authenticated()).toHaveLength(1);
    expect(authenticated()[0]).toMatchObject({
      id,
      ip: "127.0.0.1",
      name: hostname.split(".")[0],
      acme: false,
    });
    socket.destroy();
    await once(socket, "close");
    await push(secondPeer, id);
    await delay(20);
    expect(authenticated()).toHaveLength(1);
    const acme = phone(await second.registered, ["acme-tls/1"], port);
    sockets.push(acme);
    await once(acme, "secureConnect");
    const acmePeer = peers[2];
    assert.ok(acmePeer);
    await push(acmePeer, String(acmePeer.request[headers.connectionId]));
    await delay(20);
    expect(authenticated()).toHaveLength(1);
  } finally {
    for (const socket of sockets) socket.destroy();
    await relay.close();
    target.close();
  }
});
