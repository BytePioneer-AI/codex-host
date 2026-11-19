import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { connect as connectHttp2, createServer as createHttp2Server } from "node:http2";
import { Duplex } from "node:stream";
import { connect, createSecureContext, type ConnectionOptions } from "node:tls";
import { it, type TestContext } from "node:test";
import { headers } from "@codexhost/remote-relay/protocol";
import { RelayTls } from "../src/remote-relay/tls.ts";
import { RequestTrust } from "../src/request-trust.ts";
import { credentials } from "./support/relay.ts";

async function fixture(t: TestContext) {
  const http = createServer();
  const trust = new RequestTrust(undefined);
  const tls = new RelayTls(http, trust);
  const server = createHttp2Server();
  server.on("stream", (stream) => {
    stream.on("error", () => stream.destroy());
    stream.respond({ ":status": 200 });
    tls.accept(stream, { [headers.clientAddress]: "198.51.100.23" }, "phone.relay.test");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const session = connectHttp2(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  const phones: Array<ReturnType<typeof connect>> = [];
  t.after(async () => {
    for (const phone of phones) phone.destroy();
    session.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const stream = () => session.request({ ":method": "POST", ":path": "/" });
  const phone = (options: ConnectionOptions = {}) => {
    const socket = connect({
      socket: stream(),
      servername: "phone.relay.test",
      ALPNProtocols: ["acme-tls/1"],
      rejectUnauthorized: false,
      ...options,
    });
    phones.push(socket);
    return socket;
  };
  return { tls, phone, stream, http, trust };
}

it("multiplexes relay requests with socket trust and response finish callbacks", async (t) => {
  const f = await fixture(t);
  f.tls.useCertificate(createSecureContext(credentials));
  let finished = 0;
  const sockets = new Set();
  f.http.on("request", (request, response) => {
    assert.equal(request.httpVersion, "2.0");
    assert.equal(f.trust.secure(request), true);
    assert.equal(f.trust.sameOrigin(request), true);
    assert.equal(f.trust.clientAddress(request), "198.51.100.23");
    assert.equal(f.trust.relaySockets.get(request.socket)?.origin, "https://phone.relay.test");
    sockets.add(request.socket);
    response.once("finish", () => finished++);
    response.write("first");
    setTimeout(() => response.end("last"), 25);
  });
  const socket = f.phone({ ALPNProtocols: ["h2", "http/1.1"] });
  await once(socket, "secureConnect");
  assert.equal(socket.alpnProtocol, "h2");
  const session = connectHttp2("https://phone.relay.test", { createConnection: () => socket });
  t.after(() => session.destroy());
  const settings = await once(session, "remoteSettings");
  assert.equal(settings[0].enableConnectProtocol, false);
  await Promise.all(
    Array.from({ length: 12 }, async () => {
      const request = session.request({
        ":path": "/",
        origin: "https://phone.relay.test",
        "x-forwarded-for": "127.0.0.1",
      });
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (part) => (body += part));
      await once(request, "end");
      assert.equal(body, "firstlast");
    }),
  );
  assert.equal(sockets.size, 12, "each h2 stream has its own trusted socket proxy");
  assert.equal(finished, 12);
});

it("serves the same challenge concurrently with TLS 1.2/1.3 and case-insensitive SNI", async (t) => {
  const f = await fixture(t);
  f.tls.setChallenge("phone.relay.test", credentials.cert, credentials.key);
  await Promise.all(
    ["TLSv1.2", "TLSv1.3"].flatMap((version) =>
      Array.from({ length: 3 }, async () => {
        const phone = f.phone({
          servername: "PHONE.RELAY.TEST",
          maxVersion: version as "TLSv1.2" | "TLSv1.3",
        });
        const ended = once(phone, "end");
        await once(phone, "secureConnect");
        assert.equal(phone.alpnProtocol, "acme-tls/1");
        assert.equal(phone.getProtocol(), version);
        phone.resume();
        await ended;
        phone.destroy();
      }),
    ),
  );
  assert.equal(f.tls.available, false);
});

it("closes missing/mismatched challenges and ordinary connections without a certificate", async (t) => {
  const f = await fixture(t);
  await assert.rejects(once(f.phone(), "secureConnect"));
  f.tls.setChallenge("phone.relay.test", credentials.cert, credentials.key);
  await assert.rejects(once(f.phone({ servername: "other.relay.test" }), "secureConnect"));
  await assert.rejects(once(f.phone({ ALPNProtocols: ["http/1.1"] }), "secureConnect"));
  await assert.rejects(
    once(f.phone({ ALPNProtocols: ["acme-tls/1", "http/1.1"] }), "secureConnect"),
  );
  f.tls.clearChallenge();
  await assert.rejects(once(f.phone(), "secureConnect"));
});

it(
  "closes a half ClientHello after the shared ten-second deadline",
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t);
    let capture!: (bytes: Buffer) => void;
    const hello = new Promise<Buffer>((resolve) => {
      capture = resolve;
    });
    const transport = new Duplex({
      read() {},
      write(bytes, _encoding, callback) {
        capture(bytes);
        callback();
      },
    });
    const phone = connect({ socket: transport, servername: "phone.relay.test" });
    phone.on("error", () => {});
    t.after(() => phone.destroy());
    const bytes = await hello;
    const stream = f.stream();
    stream.on("error", () => {});
    const start = performance.now();
    stream.write(bytes.subarray(0, bytes.length / 2));
    await once(stream, "close");
    assert.ok(performance.now() - start >= 9_500);
    assert.ok(performance.now() - start < 12_000);
  },
);
