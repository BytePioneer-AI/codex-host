import { GateCError } from "./errors.mjs";

const LF = 0x0a;
const CR = 0x0d;
const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;

export function serializeJsonLine(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

export class StrictJsonlDecoder {
  #buffer = Buffer.alloc(0);
  #closed = false;
  #maxFrameBytes;
  #onFrame;

  constructor(onFrame, { maxFrameBytes = DEFAULT_MAX_FRAME_BYTES } = {}) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0) {
      throw new GateCError("DECODER_CONFIG", "JSONL maxFrameBytes must be a positive integer");
    }
    this.#onFrame = onFrame;
    this.#maxFrameBytes = maxFrameBytes;
  }

  push(chunk) {
    if (this.#closed) throw new GateCError("DECODER_CLOSED", "JSONL decoder is closed");
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.#buffer = this.#buffer.length === 0 ? bytes : Buffer.concat([this.#buffer, bytes]);

    while (true) {
      const newline = this.#buffer.indexOf(LF);
      if (newline < 0) {
        this.#assertFrameSize(this.#buffer.length);
        return;
      }
      this.#assertFrameSize(newline);
      let frame = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      if (frame.at(-1) === CR) frame = frame.subarray(0, -1);
      this.#emit(frame, false);
    }
  }

  end() {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#buffer.length > 0) {
      let frame = this.#buffer;
      if (frame.at(-1) === CR) frame = frame.subarray(0, -1);
      this.#emit(frame, true);
    }
    this.#buffer = Buffer.alloc(0);
  }

  #assertFrameSize(frameBytes) {
    if (frameBytes <= this.#maxFrameBytes) return;
    this.#buffer = Buffer.alloc(0);
    throw new GateCError(
      "FRAME_TOO_LARGE",
      `Pi RPC stdout frame exceeded ${this.#maxFrameBytes} bytes without an LF delimiter`,
      { frameBytes, maxFrameBytes: this.#maxFrameBytes },
    );
  }

  #emit(frame, unterminated) {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(frame);
    this.#onFrame(text, { unterminated });
  }
}
