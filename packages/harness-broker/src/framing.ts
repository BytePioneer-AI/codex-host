import type { Socket } from "node:net";

import { HARNESS_BROKER_MAX_FRAME_BYTES } from "./protocol.js";

export function writeBrokerFrame(
  socket: Socket,
  value: unknown,
  maxBytes = HARNESS_BROKER_MAX_FRAME_BYTES,
): Promise<void> {
  const frame = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(frame) > maxBytes) {
    // Reject before a caller commits its sequence to the socket's write queue.
    throw new Error("Harness broker frame exceeds the maximum size");
  }
  return new Promise((resolve, reject) => {
    socket.write(frame, (error) => (error ? reject(error) : resolve()));
  });
}

export function consumeBrokerFrames(
  socket: Socket,
  onFrame: (value: unknown) => void,
  onError: (error: Error) => void,
  maxBytes = HARNESS_BROKER_MAX_FRAME_BYTES,
): void {
  let buffered = Buffer.alloc(0);
  let bufferedBytes = 0;
  let stopped = false;
  const fail = (error: Error): void => {
    stopped = true;
    buffered = Buffer.alloc(0);
    bufferedBytes = 0;
    onError(error);
    socket.destroy();
  };
  socket.on("data", (chunk: Buffer) => {
    if (stopped) return;
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start);
      const part = chunk.subarray(start, newline < 0 ? chunk.length : newline);
      const required = bufferedBytes + part.length;
      if (required + (newline < 0 ? 0 : 1) > maxBytes) {
        fail(new Error("Harness broker frame exceeds the maximum size"));
        return;
      }
      // Grow geometrically and scan only the new chunk, not every accumulated prefix.
      if (required > buffered.length) {
        const capacity = Math.min(maxBytes, Math.max(required, 4096, buffered.length * 2));
        const next = Buffer.allocUnsafe(capacity);
        buffered.copy(next, 0, 0, bufferedBytes);
        buffered = next;
      }
      part.copy(buffered, bufferedBytes);
      bufferedBytes = required;
      if (newline < 0) return;
      const text = buffered.toString("utf8", 0, bufferedBytes);
      bufferedBytes = 0;
      if (buffered.length > 64 * 1024) buffered = Buffer.alloc(0);
      if (text.length > 0) {
        try {
          const value = JSON.parse(text) as unknown;
          onFrame(value);
        } catch (error) {
          fail(
            error instanceof SyntaxError
              ? new Error("Harness broker received invalid JSON")
              : error instanceof Error
                ? error
                : new Error(String(error)),
          );
          return;
        }
      }
      start = newline + 1;
    }
  });
}
