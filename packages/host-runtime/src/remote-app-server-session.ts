import { PassThrough, type Writable } from "node:stream";
import type { RawData, WebSocket } from "ws";
import type { RemoteAppServerSession, RemoteAppServerSessionStreams } from "./remote-app-server.js";

function bytes(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.concat(data);
}

/** Transport loss detaches a viewer, not an active native Turn. Output continues
 * draining after disconnect; listener shutdown is the separate close operation. */
export function attachRemoteAppServerSession(options: {
  socket: WebSocket;
  framing?: "messages" | "ndjson";
  diagnosticOutput: Writable;
  createSession(streams: RemoteAppServerSessionStreams): RemoteAppServerSession;
}): { running: Promise<void>; close(): void } {
  const { socket, diagnosticOutput } = options;
  const input = new PassThrough(),
    output = new PassThrough();
  const session = options.createSession({ input, output, diagnosticOutput });
  let pending = Buffer.alloc(0);
  const send = (frame: Buffer, binary: boolean) => {
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > 16 * 1024 * 1024) {
      socket.terminate();
      return;
    }
    socket.send(frame, { binary });
  };
  output.on("data", (chunk: Buffer | string) => {
    const frame = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (options.framing === "ndjson") {
      send(frame, true);
      return;
    }
    pending = Buffer.concat([pending, frame]);
    while (true) {
      const newline = pending.indexOf(0x0a);
      if (newline < 0) break;
      send(pending.subarray(0, newline), false);
      pending = pending.subarray(newline + 1);
    }
  });
  output.once("end", () => {
    if (socket.readyState === socket.OPEN)
      socket.close(
        pending.length ? 1011 : 1000,
        pending.length ? "Host Runtime emitted an incomplete frame" : undefined,
      );
  });
  let inputTail = Promise.resolve();
  let queuedInputBytes = 0;
  let disconnecting = false,
    closing = false,
    finished = false;
  const close = () => {
    input.destroy();
    if (closing || finished) return;
    closing = true;
    try {
      session.close();
    } catch (error) {
      diagnosticOutput.write(`codexhost app-server close: ${String(error)}\n`);
    }
  };
  const disconnect = () => {
    if (disconnecting || closing || finished) return;
    disconnecting = true;
    const detach = () => {
      if (closing || finished) return;
      try {
        session.disconnect();
      } catch (error) {
        diagnosticOutput.write(`codexhost app-server disconnect: ${String(error)}\n`);
        close();
      }
    };
    void inputTail.then(detach, detach);
  };
  socket.on("message", (data, isBinary) => {
    if (isBinary && options.framing !== "ndjson") {
      socket.close(1003, "Codex app-server messages must be text");
      return;
    }
    const frame = bytes(data);
    if (queuedInputBytes + frame.length > 128 * 1024 * 1024) {
      socket.terminate();
      return;
    }
    queuedInputBytes += frame.length;
    inputTail = inputTail
      .then(
        () =>
          new Promise<void>((resolve, reject) => {
            input.write(
              options.framing === "ndjson" ? frame : Buffer.concat([frame, Buffer.from("\n")]),
              (error) => (error ? reject(error) : resolve()),
            );
          }),
      )
      .finally(() => {
        queuedInputBytes -= frame.length;
      });
    void inputTail.catch(() => socket.close(1011, "Host Runtime input failed"));
  });
  socket.once("close", disconnect);
  socket.once("error", disconnect);
  input.on("error", disconnect);
  output.on("error", disconnect);
  const running = session
    .run()
    .then((code) => {
      if (code !== 0 && socket.readyState === socket.OPEN)
        socket.close(1011, "Host Runtime exited");
    })
    .catch((error: unknown) => {
      diagnosticOutput.write(`codexhost app-server: ${String(error)}\n`);
      if (socket.readyState === socket.OPEN) socket.close(1011, "Host Runtime failed");
    })
    .finally(() => {
      finished = true;
      input.destroy();
      output.end();
    });
  return { running, close };
}
