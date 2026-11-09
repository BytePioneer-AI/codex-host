import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createServer } from "node:tls";
import { afterEach, expect, it, vi } from "vitest";
import { createRelay, type ConnectionEvent, type RelayOptions } from "../src/index.js";
import { certPath, keyPath, credentials, fakeAgent, phone, collect } from "./helpers.js";

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
afterEach(async () => {
  for (const relay of relays.splice(0)) await relay.close();
});

it("reports online without check and one offline event on disconnect", async () => {
  const events: ConnectionEvent[] = [];
  const relay = await start({ onConnection: (event) => events.push(event) });
  const agent = await fakeAgent({ port: relay.port });
  await agent.registered;
  const [name] = agent.hostname.split(".");
  if (name === undefined) throw new Error("missing agent name");
  relay.disconnect(name);
  await agent.closed;
  expect(events).toEqual([
    {
      type: "computer",
      state: "online",
      name: agent.hostname.split(".")[0],
      ip: "127.0.0.1",
      time: expect.any(Number),
    },
    {
      type: "computer",
      state: "offline",
      name: agent.hostname.split(".")[0],
      ip: "127.0.0.1",
      time: expect.any(Number),
      reason: "unregister",
    },
  ]);
});

it("reports replacement before the new online event, and heartbeat timeout", async () => {
  const events: ConnectionEvent[] = [];
  const relay = await start({
    check: () => ({ name: "alice" }),
    heartbeatInterval: 100,
    onConnection: (event) => events.push(event),
  });
  const first = await fakeAgent({ port: relay.port });
  await first.registered;
  const next = await fakeAgent({ port: relay.port, autoPong: false });
  await next.registered;
  await first.closed;
  await next.closed;
  expect(
    events.map(
      (event) =>
        event.type === "computer" && [
          event.state,
          event.state === "offline" ? event.reason : undefined,
        ],
    ),
  ).toEqual([
    ["online", undefined],
    ["offline", "replace"],
    ["online", undefined],
    ["offline", "timeout"],
  ]);
});

it.each([false, true])(
  "reports phone lifecycle and exact directional bytes (ACME: %s)",
  async (acme) => {
    const events: ConnectionEvent[] = [];
    const onUsage = vi.fn();
    const relay = await start({ onConnection: (event) => events.push(event), onUsage });
    const target = createServer(
      { ...credentials, ALPNProtocols: ["http/1.1", "acme-tls/1"] },
      (socket) => {
        socket.on("error", () => {});
        socket.on("data", () => socket.end("response"));
      },
    );
    const agent = await fakeAgent({
      port: relay.port,
      tcp: (stream) => target.emit("connection", stream),
    });
    await agent.registered;
    const client = phone(agent.hostname, acme ? ["acme-tls/1"] : undefined, relay.port);
    await once(client, "secureConnect");
    const response = collect(client);
    client.write("request");
    expect((await response).toString()).toBe("response");
    client.destroy();
    await vi.waitFor(() =>
      expect(events.filter((event) => event.type === "phone")).toHaveLength(2),
    );
    const [opened, ended] = events.filter((event) => event.type === "phone");
    expect(opened).toMatchObject({
      state: "open",
      acme,
      ip: "127.0.0.1",
      startedAt: expect.any(Number),
    });
    expect(ended).toMatchObject({ ...opened, state: "close", endedAt: expect.any(Number) });
    if (ended?.state !== "close") throw new Error("missing close event");
    expect(ended.endedAt).toBeGreaterThanOrEqual(ended.startedAt);
    for (const direction of ["upload", "download"] as const) {
      const calls = onUsage.mock.calls.filter(([, , details]) => details.direction === direction);
      expect(ended[direction]).toBe(calls.reduce((sum, [, bytes]) => sum + bytes, 0));
      expect(ended[direction]).toBeGreaterThan(7);
    }
    expect(onUsage.mock.calls.every(([, , details]) => details.acme === acme)).toBe(true);
  },
);

it("reports only the first quota crossing and closes phones", async () => {
  const onUsage = vi.fn();
  const relay = await start({ dailyQuota: 1, onUsage });
  const agent = await fakeAgent({ port: relay.port });
  await agent.registered;
  const client = phone(agent.hostname, undefined, relay.port);
  await new Promise<void>((resolve) => client.once("close", () => resolve()));
  expect(onUsage.mock.calls.filter(([, , details]) => details.quotaExceeded)).toHaveLength(1);
});
