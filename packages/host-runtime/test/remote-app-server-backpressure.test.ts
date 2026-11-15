import { EventEmitter, once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, type Writable } from "node:stream";

import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { createRemoteAppServerWebSocketListener } from "../src/remote-app-server.js";
import { attachRemoteAppServerSession } from "../src/remote-app-server-session.js";
import { SharedThreadOwner } from "../src/shared-thread-owner.js";

class ControlledSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly frames: Buffer[] = [];
  readonly callbacks: Array<() => void> = [];
  constructor(private readonly automatic = false) {
    super();
  }
  send(frame: Buffer, _options: unknown, callback: () => void): void {
    this.frames.push(Buffer.from(frame));
    if (this.automatic) queueMicrotask(callback);
    else this.callbacks.push(callback);
  }
  release(): void {
    this.callbacks.shift()?.();
  }
  close(): void {
    if (this.readyState !== this.OPEN) return;
    this.readyState = 3;
    this.emit("close");
  }
  terminate(): void {
    this.close();
  }
}

function sharedViewer(
  owner: SharedThreadOwner,
  socket: ControlledSocket,
  framing: "messages" | "ndjson",
) {
  const outputErrors: Error[] = [];
  let output: Writable | undefined;
  const binding = attachRemoteAppServerSession({
    socket: socket as unknown as WebSocket,
    framing,
    diagnosticOutput: new PassThrough(),
    createSession: (streams) => {
      output = streams.output;
      streams.output.on("error", (error) => outputErrors.push(error));
      return owner.createSession(streams);
    },
  });
  if (!output) throw new Error("Missing viewer output");
  return { ...binding, output, outputErrors };
}

async function fixture(finishAfterQueue = false) {
  const directory = await mkdtemp(path.join(tmpdir(), "ch-backpressure-"));
  const socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\${path.basename(directory)}`
      : path.join(directory, "control.sock");
  const largeResponse = JSON.stringify({ id: 1, result: "x".repeat(24 * 1024 * 1024) });
  const outputDrained = Promise.withResolvers<undefined>();
  const hardClose = vi.fn();
  const listener = createRemoteAppServerWebSocketListener({
    socketPath,
    diagnosticOutput: new PassThrough(),
    createSession: ({ input, output }) => {
      hardClose.mockImplementation(() => (input as PassThrough).end());
      return {
        async run() {
          for await (const chunk of input) {
            const request = JSON.parse(String(chunk)) as { id: number };
            const response =
              request.id === 1
                ? `${largeResponse}\n${JSON.stringify({ method: "history/complete" })}\n`
                : `${JSON.stringify({ id: 2, result: "still connected" })}\n`;
            const written = new Promise<void>((resolve, reject) => {
              output.write(response, (error) => (error ? reject(error) : resolve()));
            });
            if (finishAfterQueue) {
              void written.then(() => outputDrained.resolve(undefined));
              return 0;
            }
            await written;
            outputDrained.resolve(undefined);
          }
          return 0;
        },
        disconnect: () => (input as PassThrough).end(),
        close: hardClose,
      };
    },
  });
  await listener.listen();
  const client = new WebSocket("ws://localhost/", {
    maxPayload: 0,
    createConnection: () => net.createConnection(socketPath),
  });
  await once(client, "open");
  return {
    client,
    largeResponse,
    outputDrained,
    hardClose,
    stop: () => listener.close(),
    async close() {
      client.terminate();
      await listener.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe("remote app-server output backpressure", () => {
  it("releases sent notification waiters while a slow viewer's queue stays nonempty", async () => {
    const owner = new SharedThreadOwner();
    const socket = new ControlledSocket();
    const viewer = sharedViewer(owner, socket, "ndjson");
    const frame = JSON.stringify({ method: "progress", params: { text: "x".repeat(1024) } }) + "\n";
    const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
    const listeners = () =>
      ["drain", "error", "close"].map((event) => viewer.output.listenerCount(event));
    try {
      for (let index = 0; index < 128; index++) owner.output.write(frame);
      await tick();
      const queued = viewer.output.writableLength;
      const before = listeners();
      expect(queued).toBeGreaterThan(viewer.output.writableHighWaterMark);
      for (let index = 0; index < 300; index++) {
        socket.release();
        await tick();
        owner.output.write(frame);
        await tick();
      }
      expect(viewer.output.writableLength).toBe(queued);
      expect(socket.frames).toHaveLength(301);
      expect(listeners()).toEqual(before);
      expect(socket.readyState).toBe(socket.OPEN);
      expect(viewer.outputErrors).toEqual([]);
    } finally {
      viewer.close();
      await viewer.running;
      owner.close();
    }
  });

  it.each(["messages", "ndjson"] as const)(
    "allows one large %s response to wait behind a small notification",
    async (framing) => {
      const owner = new SharedThreadOwner();
      const socket = new ControlledSocket();
      const viewer = sharedViewer(owner, socket, framing);
      try {
        owner.output.write('{"method":"before"}\n');
        await vi.waitFor(() => expect(socket.frames.length).toBe(1));
        owner.output.write(
          JSON.stringify({ method: "large", params: { text: "x".repeat(10 * 1024 * 1024) } }) +
            "\n",
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(socket.readyState).toBe(socket.OPEN);
        expect(socket.frames.length).toBe(1);
        socket.release();
        await vi.waitFor(() => expect(socket.frames.length).toBe(2));
        const response = socket.frames[1];
        if (!response) throw new Error("Missing large response");
        expect(JSON.parse(response.toString()).params.text.length).toBe(10 * 1024 * 1024);
        socket.release();
        await new Promise<void>((resolve) => setImmediate(resolve));
        owner.output.write('{"method":"after"}\n');
        await vi.waitFor(() => expect(socket.frames.length).toBe(3));
        expect(socket.readyState).toBe(socket.OPEN);
        socket.release();
        expect(viewer.outputErrors).toEqual([]);
      } finally {
        viewer.close();
        await viewer.running;
        owner.close();
      }
    },
  );

  it("does not admit a second large frame while the first is still queued", async () => {
    const owner = new SharedThreadOwner();
    const socket = new ControlledSocket();
    const viewer = sharedViewer(owner, socket, "ndjson");
    try {
      owner.output.write('{"method":"before"}\n');
      await vi.waitFor(() => expect(socket.frames.length).toBe(1));
      const frame =
        JSON.stringify({ method: "large", params: { text: "x".repeat(10 * 1024 * 1024) } }) + "\n";
      owner.output.write(frame);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(socket.readyState).toBe(socket.OPEN);
      owner.output.write(frame);
      await vi.waitFor(() => expect(socket.readyState).toBe(3));
      expect(viewer.outputErrors).toEqual([]);
      await viewer.running;
    } finally {
      viewer.close();
      await viewer.running;
      owner.close();
    }
  });

  it.each(["messages", "ndjson"] as const)(
    "keeps a shared %s viewer attached during a large frame and a following notification",
    async (framing) => {
      const owner = new SharedThreadOwner();
      const socket = new ControlledSocket();
      const viewer = sharedViewer(owner, socket, framing);
      try {
        owner.output.write(
          JSON.stringify({ method: "large", params: { text: "x".repeat(10 * 1024 * 1024) } }) +
            "\n",
        );
        await vi.waitFor(() => expect(socket.frames.length).toBe(1));
        owner.output.write('{"method":"after"}\n');
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(socket.readyState).toBe(socket.OPEN);
        expect(socket.frames.length).toBe(1);
        socket.release();
        await vi.waitFor(() => expect(socket.frames.length).toBe(2));
        const following = socket.frames[1];
        if (!following) throw new Error("Missing following notification");
        expect(JSON.parse(following.toString())).toEqual({ method: "after" });
        socket.release();
      } finally {
        viewer.close();
        await viewer.running;
        owner.close();
      }
    },
  );

  it("bounds queued notifications without stopping the owner or a fast viewer", async () => {
    const owner = new SharedThreadOwner();
    owner.input.on("data", (frame: Buffer) => {
      const request = JSON.parse(frame.toString());
      owner.output.write(JSON.stringify({ id: request.id, result: "owner alive" }) + "\n");
    });
    const slow = new ControlledSocket(),
      fast = new ControlledSocket(true);
    const slowViewer = sharedViewer(owner, slow, "ndjson");
    const fastViewer = sharedViewer(owner, fast, "ndjson");
    try {
      for (const [index, size] of [10, 5, 5].entries()) {
        owner.output.write(
          JSON.stringify({ method: "output", params: { text: "x".repeat(size * 1024 * 1024) } }) +
            "\n",
        );
        await vi.waitFor(() => expect(fast.frames.length).toBe(index + 1));
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      await vi.waitFor(() => expect(slow.readyState).toBe(3));
      expect(fast.readyState).toBe(fast.OPEN);
      expect(slowViewer.outputErrors).toEqual([]);
      const peer = owner.connect();
      try {
        await expect(peer.request("check", {})).resolves.toMatchObject({ result: "owner alive" });
      } finally {
        peer.close();
      }
      await slowViewer.running;
    } finally {
      slowViewer.close();
      fastViewer.close();
      await Promise.all([slowViewer.running, fastViewer.running]);
      owner.close();
    }
  });
  it("delivers a large response and its following frames to a slow reader", async () => {
    const test = await fixture();
    try {
      const messages: string[] = [];
      const history = Promise.withResolvers<undefined>();
      const followup = Promise.withResolvers<undefined>();
      test.client.on("message", (data) => {
        messages.push(data.toString());
        if (messages.length === 2) history.resolve(undefined);
        if (messages.length === 3) followup.resolve(undefined);
      });
      test.client.once("close", (code) => {
        history.reject(new Error(`History connection closed (${code})`));
        followup.reject(new Error(`Followup connection closed (${code})`));
      });
      // Observe both promises even when the connection closes before history arrives.
      void followup.promise.catch(() => undefined);
      test.client.pause();
      test.client.send('{"id":1,"method":"thread/read"}');
      await new Promise((resolve) => setTimeout(resolve, 50));
      test.client.resume();
      await history.promise;
      expect(messages).toEqual([test.largeResponse, '{"method":"history/complete"}']);

      test.client.send('{"id":2,"method":"thread/list"}');
      await followup.promise;
      expect(messages[2]).toBe('{"id":2,"result":"still connected"}');
      expect(test.hardClose).not.toHaveBeenCalled();
    } finally {
      await test.close();
    }
  });

  it("drains queued output when the viewer disconnects without cancelling the Turn", async () => {
    const test = await fixture();
    try {
      test.client.pause();
      test.client.send('{"id":1,"method":"thread/read"}');
      await new Promise((resolve) => setTimeout(resolve, 50));
      test.client.terminate();
      await test.outputDrained.promise;
      expect(test.hardClose).not.toHaveBeenCalled();
    } finally {
      await test.close();
    }
  });

  it("can stop the listener while a completed session is still flushing to a slow viewer", async () => {
    const test = await fixture(true);
    try {
      test.client.pause();
      test.client.send('{"id":1,"method":"thread/read"}');
      await new Promise((resolve) => setTimeout(resolve, 50));
      await test.stop();
      await test.outputDrained.promise;
      expect(test.hardClose).toHaveBeenCalledOnce();
    } finally {
      await test.close();
    }
  });
});
