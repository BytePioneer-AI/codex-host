import assert from "node:assert/strict";
import { once } from "node:events";
import { it, type TestContext } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { StreamRegistry, type StreamHandler } from "../src/transport.ts";

async function connect(t: TestContext, handler: StreamHandler) {
  const registry = new StreamRegistry();
  registry.register("test/duplex", handler);
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  server.on("connection", (socket) => registry.attach(socket));
  await once(server, "listening");
  const address = server.address();
  assert.ok(typeof address === "object" && address !== null);
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
  t.after(async () => {
    socket.terminate();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const frames: Array<{
    streamId: string;
    type: string;
    value?: unknown;
    error?: { code: string; details: object };
  }> = [];
  socket.on("message", (data) => frames.push(JSON.parse(String(data))));
  await once(socket, "open");
  const send = (value: object) => socket.send(JSON.stringify(value));
  const open = (streamId: string) =>
    send({ type: "open", streamId, endpoint: "test/duplex", payload: { args: {} } });
  const wait = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() > deadline)
        throw new Error(`mux assertion timed out: ${JSON.stringify(frames)}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  return { socket, send, open, frames, wait };
}

it("answers application heartbeats without opening a logical stream or invoking a handler", async (t) => {
  let called = false;
  const h = await connect(t, () => {
    called = true;
  });
  h.send({ type: "ping", streamId: "probe-1" });
  await h.wait(() => h.frames.length === 1);
  assert.deepEqual(h.frames[0], { type: "pong", streamId: "probe-1" });
  assert.equal(called, false);
  h.open("healthy");
  await h.wait(() => called);
  h.send({ type: "ping", streamId: "probe-2" });
  await h.wait(() => h.frames.length === 2);
  assert.deepEqual(h.frames[1], { type: "pong", streamId: "probe-2" });
});

it("buffers ordered input while a consumer is paused and half-closes without dropping output", async (t) => {
  const release = Promise.withResolvers<undefined>();
  const received: unknown[] = [];
  let inputEnded = false;
  const h = await connect(t, async (_args, sink) => {
    assert.ok(sink.input);
    sink.push(sink.input.window);
    await release.promise;
    for await (const value of sink.input.items) received.push(value);
    inputEnded = true;
    sink.push("final-output");
    sink.end();
  });
  t.after(() => release.resolve(undefined));
  h.open("ordered");
  await h.wait(() => h.frames.length === 1);
  assert.deepEqual(h.frames[0]?.value, {
    maxBytes: 262_144,
    frameOverheadBytes:
      Buffer.byteLength(JSON.stringify({ type: "item", streamId: "ordered", value: null })) - 4,
  });
  const expected = Array.from({ length: 1000 }, (_, sequence) => ({ sequence, text: "中\n\\文" }));
  for (const value of expected) h.send({ type: "item", streamId: "ordered", value });
  h.send({ type: "end", streamId: "ordered" });
  assert.equal(inputEnded, false);
  release.resolve(undefined);
  await h.wait(() => h.frames.some((frame) => frame.type === "end"));
  assert.deepEqual(received, expected);
  assert.equal(h.frames.at(-2)?.value, "final-output");
});

it("bounds encoded input per stream and isolates overflow from other streams", async (t) => {
  const h = await connect(t, (_args, sink) => {
    sink.push("ready");
  });
  h.open("overflow");
  h.open("healthy");
  await h.wait(() => h.frames.length === 2);
  // JSON escaping, not just raw text bytes, consumes the advertised inbox budget.
  h.send({ type: "item", streamId: "overflow", value: "\n".repeat(140_000) });
  await h.wait(() => h.frames.some((frame) => frame.type === "error"));
  const error = h.frames.find((frame) => frame.type === "error");
  assert.equal(error?.streamId, "overflow");
  assert.equal(error?.error?.code, "gateway/uplink-overflow");
  assert.deepEqual(error?.error?.details, { endpoint: "test/duplex" });
  assert.equal(h.socket.readyState, WebSocket.OPEN);
  assert.ok(!h.frames.some((frame) => frame.streamId === "healthy" && frame.type === "error"));
});

it("rejects input after a half-close and releases pending reads on cancel, duplicate open and socket close", async (t) => {
  const ended = new Set<string>();
  const closed = new Set<string>();
  const h = await connect(t, async (_args, sink) => {
    assert.ok(sink.input);
    sink.onClose(() => {
      closed.add(sink.id);
    });
    sink.push("ready");
    for await (const value of sink.input.items) {
      void value;
    }
    ended.add(sink.id);
    // Keep output open after Client end, as a still-running terminal does.
  });
  h.open("half");
  await h.wait(() => h.frames.length === 1);
  h.send({ type: "end", streamId: "half" });
  await h.wait(() => ended.has("half"));
  assert.equal(closed.has("half"), false);
  h.send({ type: "item", streamId: "half", value: "late" });
  await h.wait(() => closed.has("half"));
  assert.equal(
    h.frames.find((frame) => frame.streamId === "half" && frame.type === "error")?.error?.code,
    "gateway/protocol",
  );

  h.open("cancelled");
  h.send({ type: "cancel", streamId: "cancelled" });
  await h.wait(() => ended.has("cancelled") && closed.has("cancelled"));
  h.open("duplicate");
  h.open("duplicate");
  await h.wait(() => ended.has("duplicate") && closed.has("duplicate"));
  h.open("disconnected");
  await h.wait(() => h.frames.some((frame) => frame.streamId === "disconnected"));
  h.socket.close();
  await h.wait(() => ended.has("disconnected") && closed.has("disconnected"));
});
