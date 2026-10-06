import { Transform } from "node:stream";
import type { JsonRpcId } from "@codexhost/protocol-core";
import type { RemoteAppServerSessionStreams } from "./remote-app-server.js";

// Match the pinned official Remote Control reassembled-message limit.
const MAX_FRAME_BYTES = 100 * 1024 * 1024;
const MAX_PENDING_BYTES = 1024 * 1024;

/** Hold shared announcements and approvals until this frontend's initialize response. */
export function createFrontendInitializationGate(
  streams: RemoteAppServerSessionStreams,
  onError: (error: Error) => void,
): { input: Transform; output: Transform; close(): void } {
  const initializeIds = new Set<JsonRpcId>();
  let ready = false;
  let pendingBytes = 0;
  const pending: Buffer[] = [];
  function frames(
    visit: (value: Record<string, unknown>, frame: Buffer, stream: Transform) => void,
  ) {
    let buffered = Buffer.alloc(0);
    return new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        try {
          buffered = Buffer.concat([buffered, chunk]);
          let newline: number;
          while ((newline = buffered.indexOf(0x0a)) >= 0) {
            if (newline > MAX_FRAME_BYTES) throw new Error("Frontend frame limit exceeded");
            const frame = buffered.subarray(0, newline + 1);
            buffered = buffered.subarray(newline + 1);
            if (frame.toString("utf8").trim().length === 0) continue;
            const value: unknown = JSON.parse(frame.toString("utf8"));
            if (typeof value !== "object" || value === null || Array.isArray(value)) {
              throw new Error("Frontend requires JSON object frames");
            }
            visit(value as Record<string, unknown>, frame, this);
          }
          if (buffered.byteLength > MAX_FRAME_BYTES)
            throw new Error("Frontend frame limit exceeded");
          callback();
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)));
        }
      },
      flush(callback) {
        callback(buffered.length > 0 ? new Error("Incomplete frontend frame") : undefined);
      },
    });
  }
  const input = frames((value, frame, stream) => {
    if (
      !ready &&
      value.method === "initialize" &&
      (typeof value.id === "string" || typeof value.id === "number")
    ) {
      if (initializeIds.size >= 32) throw new Error("Too many pending initialize requests");
      initializeIds.add(value.id);
    }
    stream.push(frame);
  });
  const output = frames((value, frame, stream) => {
    if (!ready && typeof value.method === "string") {
      pendingBytes += frame.byteLength;
      if (pendingBytes > MAX_PENDING_BYTES)
        throw new Error("Frontend initialization queue exceeded");
      pending.push(frame);
      return;
    }
    stream.push(frame);
    if (
      !ready &&
      (typeof value.id === "string" || typeof value.id === "number") &&
      initializeIds.delete(value.id) &&
      "result" in value
    ) {
      initializeIds.clear();
      ready = true;
      for (const queued of pending.splice(0)) stream.push(queued);
      pendingBytes = 0;
    }
  });
  streams.input.on("error", onError);
  streams.output.on("error", onError);
  input.on("error", onError);
  output.on("error", onError);
  streams.input.pipe(input);
  output.pipe(streams.output, { end: false });
  return {
    input,
    output,
    close() {
      streams.input.removeListener("error", onError);
      streams.output.removeListener("error", onError);
      streams.input.unpipe(input);
      output.unpipe(streams.output);
      input.destroy();
      output.destroy();
      pending.length = 0;
    },
  };
}
