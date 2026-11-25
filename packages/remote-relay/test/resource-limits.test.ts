import { once } from "node:events";
import { connect, type AddressInfo, type Socket } from "node:net";
import { createServer as createTlsServer } from "node:tls";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRelay, type RelayOptions } from "../src/index.js";
import { pruneUsage, Usage } from "../src/usage.js";
import { certPath, credentials, fakeAgent, keyPath, phone } from "./helpers.js";

const relays: ReturnType<typeof createRelay>[] = [];
const sockets: Socket[] = [];

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

function rawConnection(port: number) {
  const socket = connect({ host: "127.0.0.1", port });
  socket.on("error", () => {});
  sockets.push(socket);
  return socket;
}

const closed = (socket: Socket) =>
  new Promise<void>((resolve) => socket.once("close", () => resolve()));

async function expectConnections(relay: ReturnType<typeof createRelay>, count: number) {
  // The default-limit case observes nearly 100 socket transitions. A 50 ms polling
  // interval per transition would consume the test's timeout even on a healthy relay.
  await vi.waitFor(
    async () => {
      const current = await new Promise<number>((resolve, reject) =>
        relay.server.getConnections((error, value) => (error ? reject(error) : resolve(value))),
      );
      expect(current).toBe(count);
    },
    { interval: 5 },
  );
}

afterEach(async () => {
  vi.useRealTimers();
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const relay of relays.splice(0)) await relay.close();
  vi.restoreAllMocks();
});

describe("per-IP connection rate limits", () => {
  it.each([
    { mode: "defaults", options: {}, limit: 50, ban: 10_000 },
    {
      mode: "configured limits",
      options: { ipConnectionLimit: 3, ipConnectionWindow: 2_000, ipBanDuration: 1_000 },
      limit: 3,
      ban: 1_000,
    },
  ])(
    "rejects new TCP connections until the cooldown expires with $mode",
    async ({ options, limit, ban }) => {
      const clock = vi.spyOn(performance, "now").mockReturnValue(0);
      const relay = await start(options);
      const tls = createTlsServer(credentials);
      const agent = await fakeAgent({
        port: relay.port,
        tcp: (stream) => tls.emit("connection", stream),
      });
      await agent.registered;
      const client = phone(agent.hostname, undefined, relay.port);
      sockets.push(client);
      await once(client, "secureConnect");

      // Computer, phone and closed connections without a ClientHello share the same budget.
      for (let index = 2; index < limit; index++) {
        const pending = rawConnection(relay.port);
        await once(pending, "connect");
        await expectConnections(relay, 3);
        pending.destroy();
        await expectConnections(relay, 2);
      }

      const rejected = rawConnection(relay.port);
      await vi.waitFor(() => expect(rejected.destroyed).toBe(true));
      expect(rejected.bytesRead).toBe(0);
      clock.mockReturnValue(ban - 1);
      const stillRejected = rawConnection(relay.port);
      await vi.waitFor(() => expect(stillRejected.destroyed).toBe(true));
      expect(agent.ws.readyState).toBe(WebSocket.OPEN);
      expect(client.destroyed).toBe(false);

      // Attempts during the ban must not extend it, even when the window exceeds the ban.
      clock.mockReturnValue(ban);
      const recovered = phone(agent.hostname, undefined, relay.port);
      sockets.push(recovered);
      await once(recovered, "secureConnect");
      await expectConnections(relay, 3);
    },
  );

  it("expires individual attempts at the sliding-window boundary", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const relay = await start({ ipConnectionLimit: 2, ipConnectionWindow: 1_000 });
    const first = rawConnection(relay.port);
    await once(first, "connect");
    await expectConnections(relay, 1);
    clock.mockReturnValue(999);
    const second = rawConnection(relay.port);
    await once(second, "connect");
    await expectConnections(relay, 2);

    clock.mockReturnValue(1_000);
    const third = rawConnection(relay.port);
    await once(third, "connect");
    await expectConnections(relay, 3);
    const rejected = rawConnection(relay.port);
    await vi.waitFor(() => expect(rejected.destroyed).toBe(true));
    expect([first, second, third].every((socket) => !socket.destroyed)).toBe(true);
  });

  it("also counts attempts rejected by the total TCP connection limit", async () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const relay = await start({ maxConnections: 1, ipConnectionLimit: 2 });
    const first = rawConnection(relay.port);
    await once(first, "connect");
    await expectConnections(relay, 1);
    await closed(rawConnection(relay.port));
    first.destroy();
    await expectConnections(relay, 0);

    const rejected = rawConnection(relay.port);
    await vi.waitFor(() => expect(rejected.destroyed).toBe(true));
  });
});

describe("Relay resource limits", () => {
  it("allows computers and pending TCP connections without a total TCP limit", async () => {
    const relay = await start();
    const agents = await Promise.all(
      Array.from({ length: 3 }, () => fakeAgent({ port: relay.port })),
    );
    await Promise.all(agents.map((agent) => agent.registered));
    const pending = rawConnection(relay.port);
    await once(pending, "connect");
    await expectConnections(relay, 4);
    expect(agents.every((agent) => agent.ws.readyState === WebSocket.OPEN)).toBe(true);
    expect(pending.destroyed).toBe(false);
  });

  it.each(["maxConnections", "ipConnectionLimit", "ipConnectionWindow", "ipBanDuration"])(
    "rejects an invalid %s before creating a listener",
    (option) => {
      for (const value of [0, -1, 1.5, Number.NaN, Infinity]) {
        expect(() =>
          createRelay({ domain: "relay.test", cert: certPath, key: keyPath, [option]: value }),
        ).toThrow();
      }
    },
  );

  it("counts computers, phones and incomplete ClientHellos toward the TCP limit and releases slots", async () => {
    const relay = await start({ maxConnections: 3 });
    const tls = createTlsServer(credentials);
    const agent = await fakeAgent({
      port: relay.port,
      tcp: (stream) => tls.emit("connection", stream),
    });
    await agent.registered;
    const client = phone(agent.hostname, undefined, relay.port);
    sockets.push(client);
    await once(client, "secureConnect");
    const pending = rawConnection(relay.port);
    await once(pending, "connect");
    await expectConnections(relay, 3);

    const rejected = rawConnection(relay.port);
    await closed(rejected);
    expect(agent.ws.readyState).toBe(WebSocket.OPEN);
    expect(client.destroyed).toBe(false);
    expect(pending.destroyed).toBe(false);

    pending.destroy();
    await expectConnections(relay, 2);
    const accepted = rawConnection(relay.port);
    await once(accepted, "connect");
    await expectConnections(relay, 3);
    expect(accepted.destroyed).toBe(false);
  });
});

describe("UTC usage retention", () => {
  it("only prunes expired offline IDs without resetting retained quota or active records", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-05T23:59:59Z"));
    const oldOffline = new Usage(undefined, 100);
    const oldActive = new Usage(undefined, 100);
    oldOffline.add(40);
    oldActive.add(50);
    vi.setSystemTime(new Date("2026-11-06T00:00:00Z"));
    const todayOffline = new Usage(undefined, 100);
    todayOffline.add(100);
    const usage = new Map([
      ["old-offline", oldOffline],
      ["old-active", oldActive],
      ["today-offline", todayOffline],
    ]);
    const agents = new Map([["old-active", {}]]);

    expect(oldOffline.expired).toBe(true);
    expect(oldOffline.bytes).toBe(40);
    pruneUsage(usage, agents);
    expect([...usage.keys()]).toEqual(["old-active", "today-offline"]);
    expect(oldActive.bytes).toBe(50);
    expect(oldActive.expired).toBe(true);
    expect(todayOffline.exceeded).toBe(true);

    agents.set("today-offline", {});
    pruneUsage(usage, agents);
    expect(todayOffline.exceeded).toBe(true);
    agents.delete("old-active");
    pruneUsage(usage, agents);
    expect([...usage.keys()]).toEqual(["today-offline"]);

    vi.setSystemTime(new Date("2026-11-07T00:00:00Z"));
    agents.clear();
    pruneUsage(usage, agents);
    expect(usage.size).toBe(0);
  });
});
