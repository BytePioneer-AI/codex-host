import type { Socket } from "node:net";

import { HARNESS_BROKER_MAX_FRAME_BYTES } from "./protocol.js";

export function writeBrokerFrame(socket: Socket, value: unknown): Promise<void> {
  const frame = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(frame) > HARNESS_BROKER_MAX_FRAME_BYTES) {
    return Promise.reject(new Error("Harness broker frame exceeds the maximum size"));
  }
  return new Promise((resolve, reject) => {
    socket.write(frame, (error) => (error ? reject(error) : resolve()));
  });
}

export function consumeBrokerFrames(
  socket: Socket,
  onFrame: (value: unknown) => void,
  onError: (error: Error) => void,
): void {
  let buffered = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    if (buffered.length > HARNESS_BROKER_MAX_FRAME_BYTES) {
      onError(new Error("Harness broker frame exceeds the maximum size"));
      socket.destroy();
      return;
    }
    let newline = buffered.indexOf(0x0a);
    while (newline >= 0) {
      const frame = buffered.subarray(0, newline);
      buffered = buffered.subarray(newline + 1);
      if (frame.length > 0) {
        try {
          const value = JSON.parse(frame.toString("utf8")) as unknown;
          onFrame(value);
        } catch (error) {
          onError(
            error instanceof SyntaxError
              ? new Error("Harness broker received invalid JSON")
              : error instanceof Error
                ? error
                : new Error(String(error)),
          );
          socket.destroy();
          return;
        }
      }
      newline = buffered.indexOf(0x0a);
    }
  });
}
