import { once } from "node:events";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer as createTlsServer, type ConnectionOptions } from "node:tls";
import { connect, constants } from "node:http2";
import type * as http2 from "node:http2";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRelay } from "../src/index.js";
import { certPath, collect, credentials, delay, fakeAgent, keyPath, phone } from "./helpers.js";
import { headers, streamWindowSize, connectionWindowSize, maxPayload } from "../src/protocol.js";

vi.mock("node:http2", async (importOriginal) => {
  const actual = await importOriginal<typeof http2>();
  return { ...actual, connect: vi.fn(actual.connect) };
});

let relay: ReturnType<typeof createRelay>;
let certDirectory: string;
beforeEach(async () => {
  certDirectory = mkdtempSync(fileURLToPath(new URL("./fixtures/run-", import.meta.url)));
  copyFileSync(certPath, `${certDirectory}/cert.pem`);
  relay = createRelay({
    domain: "relay.test",
    controlHost: "relay.test",
    cert: `${certDirectory}/cert.pem`,
    key: keyPath,
  });
  relay.server.listen(4480, "127.0.0.1");
  await once(relay.server, "listening");
});
afterEach(async () => {
  await relay.close();
  rmSync(certDirectory, { recursive: true });
});

describe("phone forwarding", () => {
  it("preserves encrypted bytes and client address, with the certificate supplied by the computer", async () => {
    const encrypted: Buffer[] = [];
    let address: unknown;
    let port: unknown;
    const tls = createTlsServer(credentials, (socket) => {
      socket.on("data", (data) => socket.end(data));
    });
    const agent = await fakeAgent({
      tcp(stream, request) {
        address = request[headers.clientAddress];
        port = request[headers.clientPort];
        stream.on("data", (data) => encrypted.push(Buffer.from(data)));
        tls.emit("connection", stream);
      },
    });
    await agent.registered;
    expect(agent.session.remoteSettings.initialWindowSize).toBe(streamWindowSize);
    expect(agent.session.state.remoteWindowSize).toBe(connectionWindowSize);
    const client = phone(agent.hostname.toUpperCase());
    await once(client, "secureConnect");
    expect(client.getPeerCertificate().subject.CN).toBe("relay.test");
    expect(address).toBe("127.0.0.1");
    expect(port).toBe(String(client.localPort));
    const response = collect(client);
    client.write("private-marker-in-TLS");
    expect((await response).toString()).toBe("private-marker-in-TLS");
    expect(Buffer.concat(encrypted).includes(Buffer.from("private-marker-in-TLS"))).toBe(false);
    expect(encrypted[0]?.[0]).toBe(22);
    client.end();
  });

  it("drains a large response after the phone has half-closed its write side", async () => {
    const body = Buffer.alloc(12 * 1024 * 1024, 97);
    const tls = createTlsServer({ ...credentials, allowHalfOpen: true }, (socket) => {
      socket.on("error", () => {});
      socket.resume();
      socket.on("end", () => socket.end(body));
    });
    const agent = await fakeAgent({
      tcp: (stream) => {
        tls.emit("connection", stream);
      },
    });
    await agent.registered;
    const client = phone(agent.hostname);
    await once(client, "secureConnect");
    client.allowHalfOpen = true;
    const response = collect(client);
    client.end("request");
    expect(
      createHash("sha256")
        .update(await response)
        .digest("hex"),
    ).toBe(createHash("sha256").update(body).digest("hex"));
  });

  it.each(["reset", "disconnect", "goaway", "replace"])(
    "closes live phones on computer %s",
    async (action) => {
      const tls = createTlsServer(credentials);
      const agent = await fakeAgent({
        tcp: (stream) => {
          tls.emit("connection", stream);
        },
      });
      await agent.registered;
      const client = phone(agent.hostname);
      await once(client, "secureConnect");
      const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
      if (action === "reset") agent.streams[0]?.close(constants.NGHTTP2_CANCEL);
      if (action === "disconnect") agent.ws.terminate();
      if (action === "goaway") agent.session.goaway();
      if (action === "replace") {
        const next = await fakeAgent({ privateKey: agent.privateKey });
        await next.registered;
        expect(await agent.closed).toBe(4409);
      }
      client.resume();
      await closed;
    },
  );

  it("rejects connection 33 while preserving the first 32", async () => {
    const tls = createTlsServer(credentials);
    const agent = await fakeAgent({
      tcp: (stream) => {
        tls.emit("connection", stream);
      },
    });
    await agent.registered;
    const phones = Array.from({ length: 32 }, () => phone(agent.hostname));
    await Promise.all(phones.map((client) => once(client, "secureConnect")));
    const extra = phone(agent.hostname);
    await new Promise<void>((resolve) => extra.once("close", () => resolve()));
    expect(agent.streams).toHaveLength(32);
    expect(phones.every((client) => !client.destroyed)).toBe(true);
    phones.forEach((client) => client.destroy());
  });

  it.each([
    "aaaaaaaaaaaaaaaaaaaaaaaaaa.relay.test",
    "bad.relay.test",
    "aaaaaaaaaaaaaaaaaaaaaaaaaa.other.test",
    "a.b.relay.test",
  ])("closes offline or invalid SNI %s without response", async (name) => {
    const client = phone(name);
    let received = 0;
    client.on("data", (data) => {
      received += data.length;
    });
    await new Promise<void>((resolve) => client.once("close", () => resolve()));
    expect(received).toBe(0);
  });

  it("transfers several times faster than a 64 KiB stream window with delayed window updates", async () => {
    const actual = await vi.importActual<typeof http2>("node:http2");
    const tls = createTlsServer(credentials, (socket) => {
      socket.on("error", () => {});
      socket.once("data", () => socket.end(Buffer.alloc(2 * 1024 * 1024)));
    });
    const durations: number[] = [];
    for (const smallWindow of [true, false]) {
      if (smallWindow) {
        vi.mocked(connect).mockImplementationOnce((authority, options) =>
          actual.connect(authority, {
            ...options,
            settings: { ...options?.settings, initialWindowSize: 64 * 1024 },
          }),
        );
      }
      const agent = await fakeAgent({
        controlDelay: 25,
        tcp: (stream) => {
          tls.emit("connection", stream);
        },
      });
      await agent.registered;
      expect(agent.session.remoteSettings.initialWindowSize).toBe(
        smallWindow ? 64 * 1024 : streamWindowSize,
      );
      const client = phone(agent.hostname);
      await once(client, "secureConnect");
      const response = collect(client);
      const start = performance.now();
      client.write("download");
      expect((await response).length).toBe(2 * 1024 * 1024);
      durations.push(performance.now() - start);
      client.destroy();
      agent.ws.terminate();
      await agent.closed;
    }
    expect(durations[0] as number).toBeGreaterThan(3 * (durations[1] as number));
  }, 10_000);

  it.each([1, 2, 8])(
    "backpressures %i slow phones within the receive window while another phone gets a response",
    async (slowCount) => {
      let produced = 0;
      const tls = createTlsServer(credentials, (socket) => {
        socket.on("error", () => {});
        socket.once("data", (data) => {
          if (data.toString() === "small") {
            socket.end("quick");
            return;
          }
          const chunk = Buffer.alloc(16 * 1024);
          const send = () => {
            while (!socket.destroyed && produced < 64 * 1024 * 1024) {
              produced += chunk.length;
              if (!socket.write(chunk)) {
                socket.once("drain", send);
                return;
              }
            }
            if (!socket.destroyed) socket.end();
          };
          send();
        });
      });
      const agent = await fakeAgent({
        tcp: (stream) => {
          tls.emit("connection", stream);
        },
      });
      await agent.registered;
      const session = vi.mocked(connect).mock.results.at(-1)?.value;
      const requests = vi.spyOn(session, "request");
      const slowPhones = Array.from({ length: slowCount }, () => phone(agent.hostname));
      await Promise.all(slowPhones.map((slow) => once(slow, "secureConnect")));
      for (const slow of slowPhones) {
        slow.write("large");
        slow.pause();
      }
      // TCP/TLS buffers may drain through several window updates before every stream stalls.
      await vi.waitFor(
        async () => {
          expect(requests.mock.results).toHaveLength(slowCount);
          for (const result of requests.mock.results) {
            expect(result.value.state.localWindowSize).toBe(0);
          }
          const before = produced;
          await delay(300);
          expect(produced).toBe(before);
        },
        { timeout: 3000, interval: 50 },
      );
      expect(produced).toBeGreaterThanOrEqual(streamWindowSize * slowCount);
      // Exhausting the producer's data must not count as backpressure.
      expect(produced).toBeLessThan(64 * 1024 * 1024);
      expect(requests.mock.results).toHaveLength(slowCount);
      for (const result of requests.mock.results) {
        expect(result.value.readableLength).toBeGreaterThan(64 * 1024);
        expect(result.value.readableLength).toBeLessThanOrEqual(streamWindowSize);
      }
      const quick = phone(agent.hostname);
      await once(quick, "secureConnect");
      const response = collect(quick);
      const start = performance.now();
      quick.write("small");
      expect((await response).toString()).toBe("quick");
      expect(performance.now() - start).toBeLessThan(1000);
      quick.end();
      slowPhones.forEach((slow) => slow.destroy());
    },
  );
});

describe("control registration", () => {
  it("registers and replaces the same identity, then registers again without retaining old Duplexes", async () => {
    const first = await fakeAgent();
    expect(await first.registered).toBe(first.hostname);
    expect(first.challenges).toHaveLength(1);
    expect(Buffer.from(first.challenges[0] as string, "base64url")).toHaveLength(32);
    const second = await fakeAgent({ privateKey: first.privateKey });
    expect(await second.registered).toBe(first.hostname);
    expect(await first.closed).toBe(4409);
    const third = await fakeAgent({ privateKey: first.privateKey });
    expect(await third.registered).toBe(first.hostname);
    expect(await second.closed).toBe(4409);
  });

  it.each([{ invalid: true }, { signHost: "other-relay.test" }])(
    "rejects an invalid or forwarded signature: %j",
    async (options) => {
      const agent = await fakeAgent(options);
      expect(await agent.closed).toBe(4401);
    },
  );

  it.each([
    { [headers.publicKey]: Buffer.alloc(31).toString("base64url") },
    { [headers.publicKey]: Buffer.alloc(33).toString("base64url") },
    { [headers.signature]: Buffer.alloc(63).toString("base64url") },
    { [headers.signature]: Buffer.alloc(65).toString("base64url") },
    { [headers.publicKey]: ["AA", "AA"] },
    { [headers.signature]: ["AA", "AA"] },
    { [headers.signature]: `${Buffer.alloc(64).toString("base64url")}==` },
    { [headers.publicKey]: "!".repeat(43) },
  ])(
    "rejects noncanonical, repeated, or wrong-length registration fields: %j",
    async (registrationHeaders) => {
      const agent = await fakeAgent({ registrationHeaders });
      expect(await agent.closed).toBe(4401);
    },
  );

  it("does not forward a phone before registration and sends only one challenge", async () => {
    const agent = await fakeAgent({ silent: true });
    const client = phone(agent.hostname);
    await new Promise<void>((resolve) => client.once("close", () => resolve()));
    expect(agent.streams).toHaveLength(0);
    expect(agent.challenges).toHaveLength(1);
  });

  it("disconnects a control sending a websocket message larger than 1 MiB", async () => {
    const agent = await fakeAgent();
    await agent.registered;
    agent.ws.send(Buffer.alloc(maxPayload + 1));
    expect([1006, 1009]).toContain(await agent.closed);
    const client = phone(agent.hostname);
    await new Promise<void>((resolve) => client.once("close", () => resolve()));
  });

  it("normalizes the configured signing host without a port or trailing dot", async () => {
    await relay.close();
    relay = createRelay({
      domain: "relay.test",
      controlHost: "RELAY.TEST.:4480",
      cert: certPath,
      key: keyPath,
    });
    relay.server.listen(4480, "127.0.0.1");
    await once(relay.server, "listening");
    const agent = await fakeAgent({ signHost: "RELAY.TEST.:4480" });
    expect(await agent.registered).toBe(agent.hostname);
  });

  it("closes an unregistered computer after ten seconds", async () => {
    const agent = await fakeAgent({ silent: true });
    expect(await agent.closed).toBe(4408);
  }, 12_000);

  it("returns HTTP 404 without upgrading an unknown version", async () => {
    // ws forwards SNI to tls.connect, but ClientOptions omits servername.
    const wsOptions = {
      servername: "relay.test",
      rejectUnauthorized: false,
    } satisfies WebSocket.ClientOptions & Pick<ConnectionOptions, "servername">;
    const ws = new WebSocket("wss://127.0.0.1:4480/v2/agent", wsOptions);
    ws.on("error", () => {});
    const response = await new Promise<number | undefined>((resolve) =>
      ws.once("unexpected-response", (_request, response) => {
        resolve(response.statusCode);
        response.resume();
        ws.terminate();
      }),
    );
    expect(response).toBe(404);
  });

  it("unregisters a computer that does not answer websocket pings", async () => {
    await relay.close();
    relay = createRelay({
      domain: "relay.test",
      cert: certPath,
      key: keyPath,
      controlHost: "relay.test",
      heartbeatInterval: 40,
    });
    relay.server.listen(4480, "127.0.0.1");
    await once(relay.server, "listening");
    const agent = await fakeAgent({ autoPong: false });
    await agent.registered;
    expect(await agent.closed).toBe(1006);
    const client = phone(agent.hostname);
    await new Promise<void>((resolve) => client.once("close", () => resolve()));
  });

  it("routes an ID-shaped control hostname to TLS before looking up an agent", async () => {
    await relay.close();
    relay = createRelay({
      domain: "relay.test",
      controlHost: "aaaaaaaaaaaaaaaaaaaaaaaaaa.relay.test",
      cert: certPath,
      key: keyPath,
    });
    relay.server.listen(4480, "127.0.0.1");
    await once(relay.server, "listening");
    const agent = await fakeAgent({ controlHost: "aaaaaaaaaaaaaaaaaaaaaaaaaa.relay.test" });
    expect(await agent.registered).toBe(agent.hostname);
  });

  it("reloads certificates on SIGHUP without closing existing controls", async () => {
    const agent = await fakeAgent();
    await agent.registered;
    const first = phone("RELAY.TEST", ["h2", "http/1.1"]);
    await once(first, "secureConnect");
    expect(first.alpnProtocol).toBe("http/1.1");
    const fingerprint = first.getPeerCertificate().fingerprint256;
    copyFileSync(new URL("./fixtures/renewed.pem", import.meta.url), `${certDirectory}/cert.pem`);
    process.emit("SIGHUP");
    const next = phone("relay.test");
    await once(next, "secureConnect");
    expect(next.getPeerCertificate().fingerprint256).not.toBe(fingerprint);
    await delay(20);
    expect(agent.ws.readyState).toBe(WebSocket.OPEN);
    expect(first.destroyed).toBe(false);
    first.destroy();
    next.destroy();
  });
});
