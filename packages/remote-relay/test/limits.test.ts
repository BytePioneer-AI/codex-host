import { once } from "node:events";
import type { ServerHttp2Stream } from "node:http2";
import { connect, createServer, type AddressInfo } from "node:net";
import { createServer as createTlsServer } from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRelay, type RelayOptions } from "../src/index.js";
import { Usage } from "../src/usage.js";
import { TokenBucket } from "../src/bandwidth.js";
import { certPath, collect, credentials, delay, fakeAgent, keyPath, phone } from "./helpers.js";

let relay: ReturnType<typeof createRelay> | undefined;
async function start(options: Partial<RelayOptions> = {}) {
  relay = createRelay({
    domain: "relay.test",
    controlHost: "relay.test",
    cert: certPath,
    key: keyPath,
    ...options,
  });
  relay.server.listen(4482, "127.0.0.1");
  await once(relay.server, "listening");
}
const closed = (socket: NodeJS.EventEmitter) =>
  new Promise<void>((resolve) => socket.once("close", () => resolve()));
afterEach(async () => {
  vi.useRealTimers();
  await relay?.close();
  relay = undefined;
  await delay(5);
  vi.restoreAllMocks();
});

// Keep socket I/O real while advancing the token buckets and their scheduled retries.
async function advanceTransfer<T>(transfer: Promise<T>): Promise<T> {
  let settled = false;
  void transfer.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let elapsed = 0; !settled && elapsed < 8000; elapsed += 10) {
    await vi.advanceTimersByTimeAsync(10);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(settled, "transfer should finish within eight virtual seconds").toBe(true);
  return transfer;
}

describe("bandwidth and UTC quota", () => {
  it("uses one second token capacity independently in each direction", () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    const upload = new TokenBucket(100);
    const download = new TokenBucket(100);
    expect(upload.take(100)).toBe(0);
    expect(upload.take(50)).toBe(500);
    expect(download.take(100)).toBe(0);
    vi.advanceTimersByTime(500);
    expect(upload.take(50)).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(upload.take(100)).toBe(0);
    expect(upload.take(1)).toBe(10);
    vi.useRealTimers();
  });

  it("resets the quota on the next UTC date, not on reconnect or local midnight", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T23:59:59Z"));
    const usage = new Usage(undefined, 100);
    expect(usage.add(99)).toBe(false);
    expect(usage.add(1)).toBe(true);
    expect(usage.add(1)).toBe(false);
    expect(usage.exceeded).toBe(true);
    vi.setSystemTime(new Date("2026-01-02T00:00:00Z"));
    expect(usage.exceeded).toBe(false);
    expect(usage.bytes).toBe(0);
    expect(usage.add(100)).toBe(true);
    vi.useRealTimers();
  });

  it("resets the shared ACME allowance at the next UTC hour", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T12:59:59Z"));
    const usage = new Usage(undefined, 1);
    usage.add(1);
    usage.add(1024 * 1024, true);
    expect(usage.acmeRemaining).toBe(0);
    vi.setSystemTime(new Date("2026-01-01T13:00:00Z"));
    expect(usage.acmeRemaining).toBe(1024 * 1024);
    expect(usage.exceeded).toBe(true);
    vi.useRealTimers();
  });

  it.each(["upload", "download"])(
    "shares the %s rate across an ID's phones, without slowing another ID",
    async (direction) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      await start({ rate: 32 * 1024 });
      const size = 48 * 1024;
      const tls = createTlsServer(credentials, (socket) => {
        socket.on("error", () => {});
        let received = 0;
        socket.on("data", (chunk) => {
          if (chunk.toString() === "small") {
            socket.end("quick");
            return;
          }
          received += chunk.length;
          if (direction === "download") socket.end(Buffer.alloc(size, 97));
          else if (received === size) socket.end("ok");
        });
      });
      const tcp = (stream: ServerHttp2Stream) => {
        tls.emit("connection", stream);
      };
      const agent = await fakeAgent({ port: 4482, tcp });
      await agent.registered;
      const other = await fakeAgent({ port: 4482, tcp });
      await other.registered;
      const phones = [
        phone(agent.hostname, undefined, 4482),
        phone(agent.hostname, undefined, 4482),
      ];
      await Promise.all(phones.map((socket) => once(socket, "secureConnect")));
      const startTime = performance.now();
      const results = phones.map((socket) => {
        const result = collect(socket);
        socket.write(direction === "download" ? "large" : Buffer.alloc(size, 97));
        return result;
      });
      const quick = phone(other.hostname, undefined, 4482);
      await once(quick, "secureConnect");
      const quickResult = collect(quick);
      quick.write("small");
      expect((await quickResult).toString()).toBe("quick");
      expect(performance.now() - startTime).toBeLessThan(1000);
      const output = await advanceTransfer(Promise.all(results));
      expect(performance.now() - startTime).toBeGreaterThanOrEqual(1800);
      expect(output.map((bytes) => bytes.length)).toEqual(
        direction === "download" ? [size, size] : [2, 2],
      );
    },
    10_000,
  );

  it("closes all phones on quota, preserves counts on reconnect, and logs metadata only", async () => {
    const logs: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      logs.push(String(chunk));
      return true;
    });
    await start({ dailyQuota: 12 * 1024 });
    const tls = createTlsServer(credentials, (socket) => {
      socket.on("error", () => {});
      socket.on("data", (chunk) => {
        if (chunk.toString() === "hello") socket.write("private-marker");
      });
    });
    const tcp = (stream: ServerHttp2Stream) => {
      tls.emit("connection", stream);
    };
    const agent = await fakeAgent({ port: 4482, tcp });
    await agent.registered;
    const idle = phone(agent.hostname, undefined, 4482);
    const active = phone(agent.hostname, undefined, 4482);
    await Promise.all([once(idle, "secureConnect"), once(active, "secureConnect")]);
    const idleClosed = closed(idle);
    const activeClosed = closed(active);
    active.write("hello");
    const [echo] = await once(active, "data");
    expect(echo.toString()).toBe("private-marker");
    active.write(Buffer.alloc(20 * 1024, 97));
    await Promise.all([idleClosed, activeClosed]);
    const denied = phone(agent.hostname, undefined, 4482);
    await closed(denied);
    const replacement = await fakeAgent({ port: 4482, privateKey: agent.privateKey, tcp });
    await replacement.registered;
    expect(await agent.closed).toBe(4409);
    const stillDenied = phone(agent.hostname, undefined, 4482);
    await closed(stillDenied);
    const other = await fakeAgent({ port: 4482, tcp });
    await other.registered;
    const allowed = phone(other.hostname, undefined, 4482);
    await once(allowed, "secureConnect");
    allowed.destroy();
    other.ws.terminate();
    await other.closed;
    await delay(10);
    const events = logs.map((line) => JSON.parse(line));
    expect(events.filter((event) => event.reason === "quota")).toHaveLength(1);
    expect(new Set(events.map((event) => event.reason))).toEqual(
      new Set(["register", "replace", "unregister", "quota"]),
    );
    for (const event of events)
      expect(
        Object.keys(event).every((key) => ["id", "ip", "time", "bytes", "reason"].includes(key)),
      ).toBe(true);
    expect(logs.join("")).not.toContain("private-marker");
  });

  it("allows only the exact ACME ALPN over quota and caps combined bytes at 64 KiB", async () => {
    await start({ dailyQuota: 1 });
    let received = 0;
    const tls = createTlsServer({ ...credentials, ALPNProtocols: ["acme-tls/1"] }, (socket) => {
      socket.on("error", () => {});
      socket.on("data", (chunk) => {
        received += chunk.length;
        socket.write("ack");
      });
    });
    const agent = await fakeAgent({
      port: 4482,
      tcp: (stream) => {
        tls.emit("connection", stream);
      },
    });
    await agent.registered;
    await closed(phone(agent.hostname, undefined, 4482));
    await closed(phone(agent.hostname, ["acme-tls/1", "http/1.1"], 4482));
    const validation = phone(agent.hostname, ["acme-tls/1"], 4482);
    await once(validation, "secureConnect");
    expect(validation.alpnProtocol).toBe("acme-tls/1");
    validation.write("challenge");
    expect((await once(validation, "data"))[0].toString()).toBe("ack");
    const ended = closed(validation);
    validation.write(Buffer.alloc(80 * 1024));
    await ended;
    expect(received).toBeLessThan(64 * 1024);
    expect(received).toBeGreaterThan(0);
  });

  it("shares the hourly ACME allowance across connections and reconnects, then rejects new validations", async () => {
    await start({ dailyQuota: 1, ipConnectionLimit: 100 });
    const tls = createTlsServer({ ...credentials, ALPNProtocols: ["acme-tls/1"] }, (socket) => {
      socket.on("error", () => {});
      socket.resume();
    });
    const tcp = (stream: ServerHttp2Stream) => {
      tls.emit("connection", stream);
    };
    const agent = await fakeAgent({ port: 4482, tcp });
    await agent.registered;
    await closed(phone(agent.hostname, undefined, 4482));
    for (let index = 0; index < 16; index++) {
      const validation = phone(agent.hostname, ["acme-tls/1"], 4482);
      await once(validation, "secureConnect");
      validation.resume();
      const ended = closed(validation);
      validation.write(Buffer.alloc(80 * 1024));
      await ended;
    }
    const count = agent.streams.length;
    await closed(phone(agent.hostname, ["acme-tls/1"], 4482));
    expect(agent.streams).toHaveLength(count);
    const replacement = await fakeAgent({ port: 4482, privateKey: agent.privateKey, tcp });
    await replacement.registered;
    await closed(phone(agent.hostname, ["acme-tls/1"], 4482));
    expect(replacement.streams).toHaveLength(0);
    const other = await fakeAgent({ port: 4482, tcp });
    await other.registered;
    await closed(phone(other.hostname, undefined, 4482));
    const allowed = phone(other.hostname, ["acme-tls/1"], 4482);
    await once(allowed, "secureConnect");
    allowed.destroy();
  });

  it("keeps over-quota ACME connections inside the 32-connection limit", async () => {
    await start({ dailyQuota: 1, ipConnectionLimit: 100 });
    const tls = createTlsServer({ ...credentials, ALPNProtocols: ["acme-tls/1"] });
    const agent = await fakeAgent({
      port: 4482,
      tcp: (stream) => {
        tls.emit("connection", stream);
      },
    });
    await agent.registered;
    await closed(phone(agent.hostname, undefined, 4482));
    const validations = Array.from({ length: 32 }, () =>
      phone(agent.hostname, ["acme-tls/1"], 4482),
    );
    await Promise.all(validations.map((socket) => once(socket, "secureConnect")));
    await closed(phone(agent.hostname, ["acme-tls/1"], 4482));
    expect(validations.every((socket) => !socket.destroyed)).toBe(true);
    validations.forEach((socket) => socket.destroy());
  });

  it("releases 32 stalled ClientHello connections so a new phone can receive a response", async () => {
    // This test deliberately opens many connections from one IP to simulate a slot-exhaustion
    // attempt; raise the per-IP limit so the unrelated rate limiter doesn't interfere.
    await start({ ipConnectionLimit: 100 });
    const tls = createTlsServer({ ...credentials, handshakeTimeout: 0 }, (socket) => {
      socket.on("error", () => {});
      socket.once("data", () => socket.end("ok"));
    });
    const agent = await fakeAgent({
      port: 4482,
      tcp: (stream) => {
        tls.emit("connection", stream);
      },
    });
    await agent.registered;

    // Capture a real ClientHello, then replay it without continuing the TLS handshake.
    const capture = createServer();
    capture.listen(0, "127.0.0.1");
    await once(capture, "listening");
    const accepted = once(capture, "connection");
    const probe = phone(agent.hostname, undefined, (capture.address() as AddressInfo).port);
    const [socket] = await accepted;
    const [hello] = await once(socket, "data");
    probe.destroy();
    socket.destroy();
    await new Promise<void>((resolve) => capture.close(() => resolve()));

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const stalled = Array.from({ length: 32 }, () => {
      const client = connect(4482, "127.0.0.1");
      client.on("error", () => {});
      client.write(hello);
      return client;
    });
    // Receiving the computer's TLS response proves all 32 slots are forwarding.
    await Promise.all(stalled.map((client) => once(client, "data")));
    await closed(phone(agent.hostname, undefined, 4482));
    const ended = Promise.all(stalled.map(closed));
    await vi.advanceTimersByTimeAsync(30 * 60_000 - 1);
    expect(stalled.every((client) => !client.destroyed)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);

    const allowed = phone(agent.hostname, undefined, 4482);
    await once(allowed, "secureConnect");
    const response = collect(allowed);
    allowed.write("hello");
    expect((await response).toString()).toBe("ok");
    await ended;
  });

  it.each(["upload", "download"])("renews the idle timeout on %s progress", async (direction) => {
    await start();
    const tls = createTlsServer(credentials);
    const agent = await fakeAgent({
      port: 4482,
      tcp: (stream) => {
        tls.emit("connection", stream);
      },
    });
    await agent.registered;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const accepted = once(tls, "secureConnection");
    const client = phone(agent.hostname, undefined, 4482);
    await once(client, "secureConnect");
    const [server] = await accepted;
    server.on("error", () => {});
    const sender = direction === "upload" ? client : server;
    const receiver = direction === "upload" ? server : client;
    for (let index = 0; index < 2; index++) {
      await vi.advanceTimersByTimeAsync(1_350_000);
      const received = once(receiver, "data");
      sender.write("still forwarding");
      expect((await received)[0].toString()).toBe("still forwarding");
    }
    client.destroy();
  });

  it("also applies the bandwidth limit to over-quota ACME traffic", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    await start({ dailyQuota: 1, rate: 8 * 1024 });
    const tls = createTlsServer({ ...credentials, ALPNProtocols: ["acme-tls/1"] }, (socket) => {
      socket.on("error", () => {});
      let received = 0;
      socket.on("data", (chunk) => {
        received += chunk.length;
        if (received === 24 * 1024) socket.end("ack");
      });
    });
    const agent = await fakeAgent({
      port: 4482,
      tcp: (stream) => {
        tls.emit("connection", stream);
      },
    });
    await agent.registered;
    await closed(phone(agent.hostname, undefined, 4482));
    const validation = phone(agent.hostname, ["acme-tls/1"], 4482);
    await once(validation, "secureConnect");
    const response = collect(validation);
    const startTime = performance.now();
    validation.write(Buffer.alloc(24 * 1024));
    expect((await advanceTransfer(response)).toString()).toBe("ack");
    expect(performance.now() - startTime).toBeGreaterThan(1800);
  });

  it("closes an over-quota ACME connection after ten seconds", async () => {
    await start({ dailyQuota: 1 });
    const tls = createTlsServer({ ...credentials, ALPNProtocols: ["acme-tls/1"] }, (socket) => {
      socket.on("error", () => {});
      socket.on("data", (chunk) => socket.write(chunk));
    });
    const agent = await fakeAgent({
      port: 4482,
      tcp: (stream) => {
        tls.emit("connection", stream);
      },
    });
    await agent.registered;
    await closed(phone(agent.hostname, undefined, 4482));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const validation = phone(agent.hostname, ["acme-tls/1"], 4482);
    await once(validation, "secureConnect");
    const startTime = performance.now();
    const ended = closed(validation);
    await vi.advanceTimersByTimeAsync(9999);
    expect(validation.destroyed).toBe(false);
    validation.write("challenge");
    expect((await once(validation, "data"))[0].toString()).toBe("challenge");
    await vi.advanceTimersByTimeAsync(1);
    await ended;
    expect(performance.now() - startTime).toBeGreaterThan(9800);
  });
});
