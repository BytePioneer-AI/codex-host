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
  await vi.waitFor(async () => {
    const current = await new Promise<number>((resolve, reject) =>
      relay.server.getConnections((error, value) => (error ? reject(error) : resolve(value))),
    );
    expect(current).toBe(count);
  });
}

afterEach(async () => {
  vi.useRealTimers();
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const relay of relays.splice(0)) await relay.close();
});

describe("optional Relay resource limits", () => {
  it("allows computers and pending TCP connections without a limit", async () => {
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

  it("rejects an invalid maxConnections before creating a listener", () => {
    for (const value of [0, -1, 1.5, Number.NaN, Infinity]) {
      expect(() =>
        createRelay({ domain: "relay.test", cert: certPath, key: keyPath, maxConnections: value }),
      ).toThrow();
    }
  });

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
