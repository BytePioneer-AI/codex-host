/*!
 * Rollout reading: zstd frame walking, streaming copy-prefix comparison.
 *
 * Copy-relation handling derived from yetone/magpie
 * (https://github.com/yetone/magpie), internal/sessions/codex_discovery.go.
 * MIT License — Copyright (c) 2026 yetone
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { createReadStream } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { constants as zstdConstants, createZstdDecompress } from "node:zlib";

const MAX_LINE = 128 * 1024 * 1024;

/** Stream each frame separately: Node's zstd streams stop at the first frame. */
export async function* rolloutBytes(file: string, signal: AbortSignal): AsyncGenerator<Buffer> {
  signal.throwIfAborted();
  const stream = createReadStream(file, { signal });
  try {
    if (!file.endsWith(".zst")) {
      for await (const chunk of stream) {
        signal.throwIfAborted();
        yield chunk;
      }
      return;
    }
    const input = stream[Symbol.asyncIterator]();
    let pending: Buffer = Buffer.alloc(0);
    // Callers only request small headers or a protocol-bounded 128 KiB block.
    async function readExact(size: number, allowEof = false): Promise<Buffer> {
      const parts: Buffer[] = [];
      let length = 0;
      while (length < size) {
        signal.throwIfAborted();
        if (!pending.length) {
          const next = await input.next();
          if (next.done) {
            if (allowEof && !length) return Buffer.alloc(0);
            throw new Error("Truncated Codex zstd rollout");
          }
          pending = next.value as Buffer;
        }
        const count = Math.min(size - length, pending.length);
        parts.push(pending.subarray(0, count));
        pending = pending.subarray(count);
        length += count;
      }
      return Buffer.concat(parts, length);
    }
    for (;;) {
      const magicBytes = await readExact(4, true);
      if (!magicBytes.length) break;
      const magic = magicBytes.readUInt32LE(0);
      if ((magic & 0xfffffff0) === 0x184d2a50) {
        let size = (await readExact(4)).readUInt32LE(0);
        while (size) {
          const count = Math.min(size, 64 * 1024);
          await readExact(count);
          size -= count;
        }
        continue;
      }
      if (magic !== 0xfd2fb528) throw new Error("Invalid Codex zstd frame");
      const descriptorBytes = await readExact(1);
      const descriptor = descriptorBytes.readUInt8(0);
      if (descriptor & 8) throw new Error("Reserved Codex zstd frame header");
      const single = (descriptor >> 5) & 1;
      const headerSize =
        (single ? 0 : 1) +
        ([0, 1, 2, 4][descriptor & 3] ?? 0) +
        ([single, 2, 4, 8][descriptor >> 6] ?? 0);
      const header = Buffer.concat([magicBytes, descriptorBytes, await readExact(headerSize)]);
      async function* frameChunks(): AsyncGenerator<Buffer> {
        yield header;
        for (;;) {
          const blockBytes = await readExact(3);
          const block = blockBytes.readUIntLE(0, 3);
          const type = (block >> 1) & 3;
          if (type === 3) throw new Error("Reserved Codex zstd block");
          const blockSize = block >>> 3;
          if (blockSize > 128 * 1024) throw new Error("Invalid Codex zstd block size");
          yield blockBytes;
          yield await readExact(type === 1 ? 1 : blockSize);
          if (block & 1) break;
        }
        if (descriptor & 4) yield await readExact(4);
      }
      const frame = Readable.from(frameChunks(), { objectMode: false });
      const decoder = createZstdDecompress({
        chunkSize: 64 * 1024,
        params: { [zstdConstants.ZSTD_d_windowLogMax]: 27 },
      });
      const completed = pipeline(frame, decoder, { signal }).then(
        () => null,
        (error) => error,
      );
      try {
        for await (const chunk of decoder) {
          signal.throwIfAborted();
          yield chunk;
        }
        const error = await completed;
        if (error) throw error;
      } finally {
        frame.destroy();
        decoder.destroy();
        await completed;
      }
    }
  } finally {
    stream.destroy();
  }
}

export async function* rolloutLines(file: string, signal: AbortSignal): AsyncGenerator<string> {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  for await (const chunk of rolloutBytes(file, signal)) {
    pending += decoder.write(chunk);
    let start = 0,
      end: number;
    while ((end = pending.indexOf("\n", start)) >= 0) {
      if (end - start > MAX_LINE) throw new Error("Codex rollout line exceeds the safety limit");
      yield pending.slice(start, end);
      start = end + 1;
    }
    pending = pending.slice(start);
    if (pending.length > MAX_LINE) throw new Error("Codex rollout line exceeds the safety limit");
  }
  pending += decoder.end();
  if (pending.trim()) yield pending;
}

/** Exact decoded-byte comparison. Even an apparent prefix must have a valid compression tail. */
export async function copyRelation(
  a: string,
  b: string,
  signal: AbortSignal,
): Promise<"different" | "a-prefix" | "b-prefix" | "equal"> {
  const left = rolloutBytes(a, signal),
    right = rolloutBytes(b, signal);
  let i = 0,
    j = 0;
  try {
    let x: IteratorResult<Buffer> = await left.next(),
      y: IteratorResult<Buffer> = await right.next();
    while (!x.done && !y.done) {
      const n = Math.min(x.value.length - i, y.value.length - j);
      if (!x.value.subarray(i, i + n).equals(y.value.subarray(j, j + n))) return "different";
      i += n;
      j += n;
      if (i === x.value.length) {
        x = await left.next();
        i = 0;
      }
      if (j === y.value.length) {
        y = await right.next();
        j = 0;
      }
    }
    if (x.done && y.done) return "equal";
    if (x.done) {
      while (!(await right.next()).done) signal.throwIfAborted();
      return "a-prefix";
    }
    while (!(await left.next()).done) signal.throwIfAborted();
    return "b-prefix";
  } finally {
    await left.return(undefined);
    await right.return(undefined);
  }
}
