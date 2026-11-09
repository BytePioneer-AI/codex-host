// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StreamHeartbeat } from "../../../apps/web-ui/packages/api/gateway/src/client/stream-heartbeat.ts";
import { RemoteStreamMuxClient } from "../../../apps/web-ui/packages/api/gateway/src/client/stream-client.ts";
import { ConnectionController } from "../../../apps/web-ui/packages/client/connection/src/client/connection.ts";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("probes idle sockets, requires the matching pong, and stops after a timeout", () => {
  const send = vi.fn();
  const failed = vi.fn();
  const heartbeat = new StreamHeartbeat(send, failed, { intervalMs: 100, timeoutMs: 20 });
  vi.advanceTimersByTime(80);
  heartbeat.received();
  vi.advanceTimersByTime(99);
  expect(send).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(send).toHaveBeenCalledWith("heartbeat-1");
  heartbeat.received("wrong-generation");
  heartbeat.received();
  vi.advanceTimersByTime(20);
  expect(failed).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(1000);
  expect(send).toHaveBeenCalledOnce();
});

it("keeps a responsive connection alive and releases all timers on stop", () => {
  const failed = vi.fn();
  let heartbeat: StreamHeartbeat;
  const send = vi.fn((id: string) => heartbeat.received(id));
  heartbeat = new StreamHeartbeat(send, failed, { intervalMs: 100, timeoutMs: 20 });
  vi.advanceTimersByTime(500);
  expect(send).toHaveBeenCalledTimes(5);
  expect(failed).not.toHaveBeenCalled();
  heartbeat.stop();
  expect(vi.getTimerCount()).toBe(0);
});

it("does not mistake a suspended background timer for a failed connection", () => {
  const send = vi.fn();
  const failed = vi.fn();
  const heartbeat = new StreamHeartbeat(send, failed, { intervalMs: 100, timeoutMs: 20 });
  vi.advanceTimersByTime(100);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  vi.advanceTimersByTime(1000);
  expect(failed).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledOnce();
  heartbeat.stop();
});

it("does not let a pending background deadline beat the deferred foreground probe", () => {
  const send = vi.fn();
  const failed = vi.fn();
  const heartbeat = new StreamHeartbeat(send, failed);
  // Deliver visibilitychange before the old deadline, but its coalesced probe after it.
  setTimeout(() => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    setTimeout(() => heartbeat.probe(), 0);
  }, 35_000);
  vi.advanceTimersByTime(25_000);
  expect(send).toHaveBeenCalledWith("heartbeat-1");
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
  vi.advanceTimersByTime(10_001);
  expect(failed).not.toHaveBeenCalled();
  expect(send).toHaveBeenLastCalledWith("heartbeat-2");
  heartbeat.received("heartbeat-2");
  heartbeat.stop();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([undefined, 6_000])(
  "uses the normal heartbeat deadline on foreground restore (timeoutMs=%s)",
  (timeoutMs) => {
    const send = vi.fn();
    const failed = vi.fn();
    const heartbeat = new StreamHeartbeat(
      send,
      failed,
      timeoutMs === undefined ? {} : { timeoutMs },
    );
    heartbeat.probe();
    vi.advanceTimersByTime(3_000);
    expect(failed).not.toHaveBeenCalled();
    heartbeat.received("heartbeat-1");
    vi.advanceTimersByTime(10_000);
    expect(failed).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();

    heartbeat.probe();
    vi.advanceTimersByTime((timeoutMs ?? 10_000) - 1);
    expect(failed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(failed).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("checks now on request, with a shorter deadline and only the newest reply counting", () => {
  const send = vi.fn();
  const failed = vi.fn();
  const heartbeat = new StreamHeartbeat(send, failed, {
    intervalMs: 100,
    timeoutMs: 50,
    restoreTimeoutMs: 20,
  });
  heartbeat.probe();
  expect(send).toHaveBeenLastCalledWith("heartbeat-1");
  heartbeat.probe();
  expect(send).toHaveBeenLastCalledWith("heartbeat-2");
  heartbeat.received("heartbeat-1");
  vi.advanceTimersByTime(19);
  expect(failed).not.toHaveBeenCalled();
  heartbeat.received("heartbeat-2");
  vi.advanceTimersByTime(99);
  expect(failed).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledTimes(2);
  heartbeat.probe();
  vi.advanceTimersByTime(20);
  expect(failed).toHaveBeenCalledOnce();
  heartbeat.probe();
  expect(send).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
});

class Socket extends EventTarget {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  sent: Array<{ type: string; streamId: string }> = [];
  close = vi.fn(() => {
    this.readyState = 3;
  });
  constructor() {
    super();
    Socket.instances.push(this);
  }
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  open() {
    this.readyState = Socket.OPEN;
    this.dispatchEvent(new Event("open"));
  }
  receive(value: object) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }
}

it("fails logical streams on a silent half-open socket and only reconnects when requested", async () => {
  Socket.instances = [];
  vi.stubGlobal("WebSocket", Socket);
  const client = new RemoteStreamMuxClient({ intervalMs: 100, timeoutMs: 20 });
  client.start();
  const socket = Socket.instances[0]!;
  const stream = client.open("session/follow", {}, new AbortController().signal);
  const first = stream.next();
  socket.open();
  await vi.advanceTimersByTimeAsync(0);
  const streamId = socket.sent[0]!.streamId;
  socket.receive({ type: "item", streamId, value: "retained history" });
  await expect(first).resolves.toMatchObject({ value: "retained history" });
  const next = expect(stream.next()).rejects.toThrow("heartbeat timed out");
  await vi.advanceTimersByTimeAsync(120);
  await next;
  expect(socket.close).toHaveBeenCalledWith(4000, "heartbeat timed out");
  expect(Socket.instances).toHaveLength(1);
  client.reconnect();
  await vi.advanceTimersByTimeAsync(0);
  expect(Socket.instances).toHaveLength(2);
  Socket.instances[1]!.open();
  await vi.advanceTimersByTimeAsync(0);
  // Retired carrier messages cannot affect the replacement heartbeat.
  socket.receive({ type: "pong", streamId: "heartbeat-1" });
  await client.close();
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps the socket and subscription through backgrounding and a slow pong, but reconnects on timeout", async () => {
  Socket.instances = [];
  vi.stubGlobal("WebSocket", Socket);
  const client = new RemoteStreamMuxClient();
  const received = vi.fn();
  const state = vi.fn();
  const controller = new ConnectionController(
    async (signal, ready) => {
      for await (const value of client.open("session/follow", {}, signal)) {
        ready({ home: "/home/test" });
        received(value);
      }
    },
    {
      onStateChange: state,
      onProbeRequested: () => client.probe(),
      onReconnectRequested: () => client.reconnect(),
    },
  );
  client.start();
  expect(client.probe()).toBe(false);
  controller.start();
  const socket = Socket.instances[0]!;
  socket.open();
  await vi.advanceTimersByTimeAsync(0);
  const streamId = socket.sent[0]!.streamId;
  socket.receive({ type: "item", streamId, value: "retained history" });
  await vi.advanceTimersByTimeAsync(0);
  expect(state).toHaveBeenLastCalledWith("connected");

  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(socket.sent).toHaveLength(1);
  expect(socket.close).not.toHaveBeenCalled();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  controller.revalidate();
  await vi.advanceTimersByTimeAsync(3_000);
  expect(state).toHaveBeenCalledOnce();
  expect(socket.close).not.toHaveBeenCalled();
  socket.receive({ type: "pong", streamId: "heartbeat-1" });
  socket.receive({ type: "item", streamId, value: "continued history" });
  await vi.advanceTimersByTimeAsync(0);
  expect(received.mock.calls).toEqual([["retained history"], ["continued history"]]);
  expect(Socket.instances).toHaveLength(1);
  expect(socket.sent.map((frame) => frame.type)).toEqual(["open", "ping"]);

  controller.revalidate();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(socket.close).toHaveBeenCalledWith(4000, "heartbeat timed out");
  expect(client.probe()).toBe(false);
  expect(state).toHaveBeenLastCalledWith("connecting");
  await vi.advanceTimersByTimeAsync(500);
  expect(Socket.instances).toHaveLength(2);
  controller.stop();
  await client.close();
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
});
