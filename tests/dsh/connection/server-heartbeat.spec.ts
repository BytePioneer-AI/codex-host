import { once } from "node:events";
import { createServer } from "node:http";
import { Context } from "@deepseek-ai/cordis";
import type { PeerScope } from "@deepseek-ai/dsh-typert-protocol";
import WebSocket from "ws";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TypertGatewayService } from "../../../apps/web-ui/packages/api/gateway/src/index.ts";
import { RemoteStreamMuxServer } from "../../../apps/web-ui/packages/api/gateway/src/stream-server.ts";

const cleanup: Array<() => Promise<void>> = [];
beforeEach(() => {
  // Keep real socket I/O and setImmediate; advance only heartbeat time.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

async function connect(intervalMs?: number) {
  const config = TypertGatewayService.Config({});
  expect(config.websocketHeartbeatIntervalMs).toBe(30_000);
  const ctx = new Context();
  const mux = new RemoteStreamMuxServer(
    async function* () {},
    () => ({ code: "gateway/internal", message: "test failure", details: {} }),
    intervalMs ?? config.websocketHeartbeatIntervalMs,
    config.streamInboxBytes,
  );
  const server = createServer();
  server.on("upgrade", (request, socket, head) => {
    mux.handleUpgrade(request, socket, head, {
      id: "heartbeat-test" as PeerScope["id"],
      ctx,
      dispose: () => ctx.fiber.dispose(),
    });
  });
  cleanup.push(async () => {
    await mux.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await ctx.fiber.dispose();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No test listener");
  const socket = new WebSocket(`ws://127.0.0.1:${String(address.port)}`, { autoPong: false });
  await once(socket, "open");
  const roundTrip = async () => {
    const reply = once(socket, "message");
    socket.send(JSON.stringify({ type: "ping", streamId: "probe" }));
    const [data] = await reply;
    expect(JSON.parse(String(data))).toEqual({ type: "pong", streamId: "probe" });
  };
  return { socket, roundTrip };
}

it("pings every 30 seconds but keeps a silent browser for ten minutes", async () => {
  const { socket } = await connect();
  const ping = vi.fn();
  socket.on("ping", ping);
  await vi.advanceTimersByTimeAsync(29_999);
  expect(ping).not.toHaveBeenCalled();
  const firstPing = once(socket, "ping");
  await vi.advanceTimersByTimeAsync(1);
  await firstPing;
  expect(ping).toHaveBeenCalledOnce();

  await vi.advanceTimersByTimeAsync(570_000 - 1);
  expect(socket.readyState).toBe(WebSocket.OPEN);
  const closed = once(socket, "close");
  await vi.advanceTimersByTimeAsync(1);
  await closed;
  expect(socket.readyState).toBe(WebSocket.CLOSED);
});

it("resets the deadline on Pong and expires by elapsed time, not missed-ping count", async () => {
  const { socket, roundTrip } = await connect(2_000);
  for (let cycle = 0; cycle < 2; cycle++) {
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.pong();
    // Ordered application traffic confirms the preceding Pong reached the server.
    await roundTrip();
  }
  await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
  expect(socket.readyState).toBe(WebSocket.OPEN);
  const closed = once(socket, "close");
  await vi.advanceTimersByTimeAsync(1);
  await closed;
});

it("does not delay explicit closure or server shutdown until the heartbeat deadline", async () => {
  const { socket } = await connect();
  const closed = once(socket, "close");
  socket.close();
  await closed;
  expect(socket.readyState).toBe(WebSocket.CLOSED);
});
