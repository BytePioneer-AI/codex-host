import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { ServerHttp2Stream } from "node:http2";
import { createServer as createTlsServer } from "node:tls";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRelay, type RegistrationResult, type RelayOptions } from "../src/index.js";
import { headers } from "../src/protocol.js";
import { Usage } from "../src/usage.js";
import { certPath, collect, credentials, delay, fakeAgent, keyPath, phone } from "./helpers.js";

const relays: ReturnType<typeof createRelay>[] = [];
async function start(options: Partial<RelayOptions> = {}) {
  const relay = createRelay({
    domain: "relay.test",
    controlHost: "relay.test",
    cert: certPath,
    key: keyPath,
    ...options,
  });
  relays.push(relay);
  relay.server.listen(0, "127.0.0.1");
  await once(relay.server, "listening");
  return { ...relay, port: (relay.server.address() as AddressInfo).port };
}
const closed = (socket: NodeJS.EventEmitter) =>
  new Promise<void>((resolve) => socket.once("close", () => resolve()));
const tls = () =>
  createTlsServer(credentials, (socket) => {
    socket.on("error", () => {});
    socket.on("data", (chunk) => socket.end(chunk));
  });

afterEach(async () => {
  for (const relay of relays.splice(0)) await relay.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("registration checks and address names", () => {
  it.each(["alice", "a", "a-b", "0", "a".repeat(63), "ALICE"])(
    "assigns and routes the DNS label %s after verifying the signature",
    async (name) => {
      const check = vi.fn(async () => ({ name }));
      const relay = await start({ check });
      const target = tls();
      const agent = await fakeAgent({
        port: relay.port,
        registrationHeaders: { [headers.name]: "wanted", [headers.invite]: "invitation" },
        tcp: (stream) => target.emit("connection", stream),
      });
      const hostname = await agent.registered;
      expect(hostname).toBe(`${name.toLowerCase()}.relay.test`);
      expect(check).toHaveBeenCalledExactlyOnceWith({
        id: agent.hostname.split(".")[0],
        ip: "127.0.0.1",
        name: "wanted",
        invite: "invitation",
      });
      const client = phone(hostname.toUpperCase(), undefined, relay.port);
      await once(client, "secureConnect");
      const response = collect(client);
      client.write("hello");
      expect((await response).toString()).toBe("hello");
      client.destroy();
      await closed(phone(agent.hostname, undefined, relay.port));
    },
  );

  it("ignores name and invite without a check", async () => {
    const relay = await start();
    const agent = await fakeAgent({
      port: relay.port,
      registrationHeaders: { [headers.name]: "alice", [headers.invite]: "invitation" },
    });
    expect(await agent.registered).toBe(agent.hostname);
    await closed(phone("alice.relay.test", undefined, relay.port));
  });

  it.each([
    ["invite", 4410],
    ["name-taken", 4411],
    ["banned", 4412],
    ["full", 4413],
  ] as const)("rejects %s with code %i without replacing an online name", async (reject, code) => {
    const check = vi
      .fn<NonNullable<RelayOptions["check"]>>()
      .mockReturnValueOnce({ name: "alice" })
      .mockReturnValue({ reject });
    const relay = await start({ check });
    const target = tls();
    const first = await fakeAgent({
      port: relay.port,
      tcp: (stream) => target.emit("connection", stream),
    });
    await first.registered;
    const denied = await fakeAgent({ port: relay.port });
    expect(await denied.closed).toBe(code);
    expect(first.ws.readyState).toBe(WebSocket.OPEN);
    const client = phone("alice.relay.test", undefined, relay.port);
    await once(client, "secureConnect");
    client.destroy();
  });

  it.each(["", "-alice", "alice-", "a.b", "a_b", "a".repeat(64)])(
    "rejects an invalid assigned DNS label %j",
    async (name) => {
      const relay = await start({ check: () => ({ name }) });
      const agent = await fakeAgent({ port: relay.port });
      expect(await agent.closed).toBe(1000);
    },
  );

  it.each([false, true])("closes registration when check throws (async: %s)", async (async) => {
    const relay = await start({
      check: () => {
        if (async) return Promise.reject(new Error("unavailable"));
        throw new Error("unavailable");
      },
    });
    const agent = await fakeAgent({ port: relay.port });
    expect(await agent.closed).toBe(1000);
    await closed(phone(agent.hostname, undefined, relay.port));
  });

  it("never calls check for an invalid signature", async () => {
    const check = vi.fn(() => ({ name: "alice" }));
    const relay = await start({ check });
    const agent = await fakeAgent({ port: relay.port, invalid: true });
    expect(await agent.closed).toBe(4401);
    expect(check).not.toHaveBeenCalled();
  });

  it("times out a pending check and ignores its late result", async () => {
    let finish!: (result: RegistrationResult) => void;
    const check = vi
      .fn<NonNullable<RelayOptions["check"]>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockReturnValue({ name: "alice" });
    const relay = await start({ check });
    const first = await fakeAgent({ port: relay.port });
    expect(await first.closed).toBe(4408);
    const next = await fakeAgent({ port: relay.port });
    expect(await next.registered).toBe("alice.relay.test");
    finish({ name: "alice" });
    await delay(20);
    expect(next.ws.readyState).toBe(WebSocket.OPEN);
  }, 12_000);

  it("replaces by name even when the identity changes", async () => {
    const relay = await start({ check: () => ({ name: "alice" }) });
    const first = await fakeAgent({ port: relay.port });
    await first.registered;
    const next = await fakeAgent({ port: relay.port });
    expect(await next.registered).toBe("alice.relay.test");
    expect(next.hostname).not.toBe(first.hostname);
    expect(await first.closed).toBe(4409);
  });

  it("disconnects controls and phones, then rechecks a reconnect with new limits", async () => {
    const check = vi
      .fn<NonNullable<RelayOptions["check"]>>()
      .mockReturnValueOnce({ name: "alice" })
      .mockReturnValueOnce({ name: "alice", dailyQuota: 1 })
      .mockReturnValue({ reject: "banned" });
    const relay = await start({ check });
    const target = tls();
    const first = await fakeAgent({
      port: relay.port,
      tcp: (stream) => target.emit("connection", stream),
    });
    await first.registered;
    const client = phone("alice.relay.test", undefined, relay.port);
    await once(client, "secureConnect");
    const ended = closed(client);
    relay.disconnect("alice");
    await ended;
    expect(await first.closed).toBe(1000);
    relay.disconnect("missing");
    const next = await fakeAgent({ port: relay.port, privateKey: first.privateKey });
    await next.registered;
    await closed(phone("alice.relay.test", undefined, relay.port));
    expect(next.streams).toHaveLength(0);
    relay.disconnect("alice");
    await next.closed;
    const banned = await fakeAgent({ port: relay.port, privateKey: first.privateKey });
    expect(await banned.closed).toBe(4412);
    expect(check).toHaveBeenCalledTimes(3);
  });
});

describe("checked limits, usage and quota notices", () => {
  it("uses the checked rate instead of the startup rate", async () => {
    const relay = await start({ rate: 1, check: () => ({ name: "alice", rate: 16 * 1024 }) });
    const target = createTlsServer(credentials, (socket) => {
      socket.on("error", () => {});
      let received = 0;
      socket.on("data", (chunk) => {
        received += chunk.length;
        if (received === 40 * 1024) socket.end("ok");
      });
    });
    const agent = await fakeAgent({
      port: relay.port,
      tcp: (stream) => target.emit("connection", stream),
    });
    await agent.registered;
    const client = phone("alice.relay.test", undefined, relay.port);
    await once(client, "secureConnect");
    const response = collect(client);
    const startTime = performance.now();
    client.write(Buffer.alloc(40 * 1024));
    expect((await response).toString()).toBe("ok");
    expect(performance.now() - startTime).toBeGreaterThan(800);
    client.destroy();
  });

  it.each([undefined, 1])(
    "applies checked quotas with startup quota %s, seeds usage, reports the same bytes, and notifies once per UTC day",
    async (dailyQuota) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-06T23:59:00Z"));
      const events: { reason: string; bytes?: number }[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        events.push(JSON.parse(String(chunk)));
        return true;
      });
      const onUsage = vi.fn();
      const relay = await start({
        ...(dailyQuota === undefined ? {} : { dailyQuota }),
        check: () => ({ name: "alice", dailyQuota: 12 * 1024, usedToday: 8 * 1024 }),
        onUsage,
      });
      const target = createTlsServer(
        { ...credentials, ALPNProtocols: ["http/1.1", "acme-tls/1"] },
        (socket) => {
          socket.on("error", () => {});
          socket.on("data", () => socket.write(Buffer.alloc(8 * 1024)));
        },
      );
      const tcp = (stream: ServerHttp2Stream) => target.emit("connection", stream);
      const agent = await fakeAgent({ port: relay.port, tcp });
      await agent.registered;
      const client = phone("alice.relay.test", undefined, relay.port);
      await once(client, "secureConnect");
      client.resume();
      const ended = closed(client);
      client.write("download");
      await ended;
      await vi.waitFor(() =>
        expect(agent.notices).toEqual([{ quota: "exhausted", until: "2026-11-07T00:00:00.000Z" }]),
      );
      expect(agent.ws.readyState).toBe(WebSocket.OPEN);
      expect(events.filter((event) => event.reason === "quota")).toHaveLength(1);
      const reported = () => onUsage.mock.calls.reduce((sum, [, bytes]) => sum + bytes, 0);
      expect(events.find((event) => event.reason === "quota")?.bytes).toBe(8 * 1024 + reported());
      expect(reported()).toBeLessThan(12 * 1024);
      expect(onUsage.mock.calls.every(([name]) => name === "alice")).toBe(true);
      expect(onUsage.mock.calls.length).toBeGreaterThan(1);
      const count = reported();
      await closed(phone("alice.relay.test", undefined, relay.port));
      expect(reported()).toBe(count);
      const validation = phone("alice.relay.test", ["acme-tls/1"], relay.port);
      await once(validation, "secureConnect");
      validation.destroy();
      await delay(20);
      expect(reported()).toBeGreaterThan(count);
      expect(agent.notices).toHaveLength(1);
      vi.setSystemTime(new Date("2026-11-07T00:00:00Z"));
      const nextDay = phone("alice.relay.test", undefined, relay.port);
      await once(nextDay, "secureConnect");
      nextDay.resume();
      const nextEnded = closed(nextDay);
      nextDay.write(Buffer.alloc(20 * 1024));
      await nextEnded;
      await vi.waitFor(() => expect(agent.notices.at(-1)?.until).toBe("2026-11-08T00:00:00.000Z"));
      expect(agent.notices).toHaveLength(2);
    },
  );

  it.each([undefined, 1000, 100_000])(
    "retains in-memory usage instead of a reconnect's usedToday %s",
    async (usedToday) => {
      const check = vi
        .fn<NonNullable<RelayOptions["check"]>>()
        .mockReturnValueOnce({ name: "alice", dailyQuota: 1000, usedToday: 1000 })
        .mockReturnValue({
          name: "alice",
          dailyQuota: 2000,
          ...(usedToday === undefined ? {} : { usedToday }),
        });
      const relay = await start({ check });
      const first = await fakeAgent({ port: relay.port });
      await first.registered;
      await vi.waitFor(() => expect(first.notices).toHaveLength(1));
      const next = await fakeAgent({ port: relay.port });
      await next.registered;
      expect(await first.closed).toBe(4409);
      const client = phone("alice.relay.test", undefined, relay.port);
      await vi.waitFor(() => expect(next.streams).toHaveLength(1));
      client.destroy();
    },
  );

  it("falls back to startup limits when check omits them", async () => {
    const relay = await start({ dailyQuota: 1, check: () => ({ name: "alice" }) });
    const agent = await fakeAgent({ port: relay.port });
    await agent.registered;
    await closed(phone("alice.relay.test", undefined, relay.port));
    await vi.waitFor(() => expect(agent.notices).toHaveLength(1));
  });

  it("keeps the control connection when an older computer rejects a notice", async () => {
    const relay = await start({ dailyQuota: 1 });
    const target = createTlsServer({ ...credentials, ALPNProtocols: ["acme-tls/1"] });
    const agent = await fakeAgent({
      port: relay.port,
      noticeStatus: 404,
      tcp: (stream) => target.emit("connection", stream),
    });
    await agent.registered;
    await closed(phone(agent.hostname, undefined, relay.port));
    const validation = phone(agent.hostname, ["acme-tls/1"], relay.port);
    await once(validation, "secureConnect");
    expect(agent.ws.readyState).toBe(WebSocket.OPEN);
    validation.destroy();
  });

  it("preserves current-day and ACME usage when updating limits", () => {
    const usage = new Usage(undefined, 100, 90);
    usage.add(10, true);
    usage.configure(10, 200, 0);
    expect(usage.bytes).toBe(100);
    expect(usage.exceeded).toBe(false);
    expect(usage.acmeRemaining).toBe(1024 * 1024 - 10);
  });

  it("starts from usedToday when only a previous UTC day's usage exists", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-06T23:59:59Z"));
    const usage = new Usage(undefined, 100, 90);
    usage.add(10);
    vi.setSystemTime(new Date("2026-11-07T00:00:00Z"));
    usage.configure(10, 200, 150);
    expect(usage.bytes).toBe(150);
    expect(usage.exceeded).toBe(false);
    expect(usage.upload?.rate).toBe(10);
    expect(usage.download?.rate).toBe(10);
    expect(usage.add(50)).toBe(true);
  });
});
