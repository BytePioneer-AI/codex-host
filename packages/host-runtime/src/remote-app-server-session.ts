import { PassThrough, type Writable } from "node:stream";
import type { RawData, WebSocket } from "ws";
import type { RemoteAppServerSession, RemoteAppServerSessionStreams } from "./remote-app-server.js";
import {
  CODEX_RUNTIME_REMOVED_MESSAGE,
  CodexRuntimeFilesRemovedError,
} from "./codex-runtime/backend-files.js";
import { RemoteAppServerOutput } from "./remote-app-server-output.js";

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
  const input = new PassThrough();
  const output = new RemoteAppServerOutput(socket, options.framing);
  const session = options.createSession({ input, output, diagnosticOutput });
  let inputTail = Promise.resolve();
  let queuedInputBytes = 0;
  let disconnecting = false,
    closing = false,
    finished = false;
  const close = () => {
    input.destroy();
    if (closing || finished) return;
    closing = true;
    socket.terminate();
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
      if (socket.readyState === socket.OPEN)
        socket.close(
          1011,
          error instanceof CodexRuntimeFilesRemovedError
            ? CODEX_RUNTIME_REMOVED_MESSAGE
            : "Host Runtime failed",
        );
    })
    .finally(async () => {
      input.destroy();
      await new Promise<void>((resolve) => output.end(resolve));
      finished = true;
    });
  return { running, close };
}
