import { Writable } from "node:stream";
import type { WebSocket } from "ws";

const MAX_QUEUED_BYTES = 8 * 1024 * 1024;
type WriteCallback = (error?: Error | null) => void;

/** One viewer's ordered output, with one large frame and a bounded ordinary queue. */
export class RemoteAppServerOutput extends Writable {
  private activeBytes = 0;
  private largeFrameBytes = 0;
  private queuedLargeBytes = 0;
  private pending = Buffer.alloc(0);

  constructor(
    private readonly socket: WebSocket,
    private readonly framing: "messages" | "ndjson" = "messages",
  ) {
    super();
  }

  override write(chunk: unknown, callback?: WriteCallback): boolean;
  override write(chunk: unknown, encoding: BufferEncoding, callback?: WriteCallback): boolean;
  override write(
    chunk: unknown,
    encodingOrCallback?: BufferEncoding | WriteCallback,
    callback?: WriteCallback,
  ): boolean {
    const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
    const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    const size =
      typeof chunk === "string"
        ? Buffer.byteLength(chunk, encoding)
        : ArrayBuffer.isView(chunk)
          ? chunk.byteLength
          : 0;
    const large = size > MAX_QUEUED_BYTES;
    const queuedBytes = this.writableLength - this.activeBytes - this.queuedLargeBytes;
    if (
      !this.destroyed &&
      (large ? this.largeFrameBytes > 0 : queuedBytes + size > MAX_QUEUED_BYTES)
    ) {
      // Losing a viewer must not turn its execution owner's output into an error.
      // Existing writes drain on close; this frame is no longer deliverable.
      this.socket.terminate();
      if (done) queueMicrotask(() => done());
      return true;
    }
    if (large && !this.destroyed) {
      this.largeFrameBytes = size;
      this.queuedLargeBytes = size;
    }
    const complete: WriteCallback = (error) => {
      if (large) this.largeFrameBytes = 0;
      done?.(error);
    };
    return encoding === undefined
      ? super.write(chunk, complete)
      : super.write(chunk, encoding, complete);
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: WriteCallback): void {
    this.activeBytes = chunk.length;
    if (chunk.length > MAX_QUEUED_BYTES) this.queuedLargeBytes = 0;
    const flush = async () => {
      if (this.framing === "ndjson") {
        await this.send(chunk, true);
        return;
      }
      this.pending = Buffer.concat([this.pending, chunk]);
      for (;;) {
        const newline = this.pending.indexOf(0x0a);
        if (newline < 0) return;
        await this.send(this.pending.subarray(0, newline), false);
        this.pending = this.pending.subarray(newline + 1);
      }
    };
    void flush().then(
      () => {
        this.activeBytes = 0;
        callback();
      },
      (error: Error) => {
        this.activeBytes = 0;
        callback(error);
      },
    );
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (this.socket.readyState === this.socket.OPEN)
      this.socket.close(
        this.pending.length ? 1011 : 1000,
        this.pending.length ? "Host Runtime emitted an incomplete frame" : undefined,
      );
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (error) this.socket.terminate();
    callback(error);
  }

  private send(frame: Buffer, binary: boolean): Promise<void> {
    return new Promise((resolve) => {
      if (this.socket.readyState !== this.socket.OPEN) {
        resolve();
        return;
      }
      const done = () => {
        this.socket.off("close", done);
        resolve();
      };
      // Detached viewers must not block the native Turn's remaining output.
      this.socket.once("close", done);
      this.socket.send(frame, { binary }, (error) => {
        if (error) this.socket.terminate();
        done();
      });
    });
  }
}
