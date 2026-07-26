import { GateCError } from "./errors.mjs";

const LF = 0x0a;
const CR = 0x0d;

export function serializeJsonLine(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

export class StrictJsonlDecoder {
  #buffer = Buffer.alloc(0);
  #closed = false;
  #onFrame;

  constructor(onFrame) {
    this.#onFrame = onFrame;
  }

  push(chunk) {
    if (this.#closed) throw new GateCError("DECODER_CLOSED", "JSONL decoder is closed");
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.#buffer = this.#buffer.length === 0 ? bytes : Buffer.concat([this.#buffer, bytes]);

    while (true) {
      const newline = this.#buffer.indexOf(LF);
      if (newline < 0) return;
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

  #emit(frame, unterminated) {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(frame);
    this.#onFrame(text, { unterminated });
  }
}
