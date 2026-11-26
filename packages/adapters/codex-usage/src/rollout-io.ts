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
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { constants as zstdConstants, createZstdDecompress } from "node:zlib";

const BLOCK_SIZE = 128 * 1024;
const ZSTD_READ_SIZE = 512 * 1024;
const MAX_LINE = 128 * 1024 * 1024;
const PEEK_BYTES = 4096;

/** Stream each frame separately: Node's zstd streams stop at the first frame. */
export async function* rolloutBytes(file: string, signal: AbortSignal): AsyncGenerator<Buffer> {
  signal.throwIfAborted();
  const stream = createReadStream(file, {
    highWaterMark: file.endsWith(".zst") ? ZSTD_READ_SIZE : BLOCK_SIZE,
    signal,
  });
  try {
    if (!file.endsWith(".zst")) {
      for await (const chunk of stream) {
        signal.throwIfAborted();
        yield chunk as Buffer;
      }
      return;
    }
    const input = stream[Symbol.asyncIterator]();
    let pending: Buffer = Buffer.alloc(0);
    // Callers only request small headers or a protocol-bounded 128 KiB block.
    async function readExact(size: number, allowEof = false): Promise<Buffer> {
      signal.throwIfAborted();
      if (pending.length >= size) {
        const slice = pending.subarray(0, size);
        pending = pending.subarray(size);
        return slice;
      }
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
      const [firstPart] = parts;
      return firstPart && parts.length === 1 ? firstPart : Buffer.concat(parts, length);
    }
    for (;;) {
      const magicBytes = await readExact(4, true);
      if (!magicBytes.length) break;
      const magic = magicBytes.readUInt32LE(0);
      if ((magic & 0xfffffff0) === 0x184d2a50) {
        let size = (await readExact(4)).readUInt32LE(0);
        while (size) {
          const count = Math.min(size, ZSTD_READ_SIZE);
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
        let done = false;
        while (!done) {
          signal.throwIfAborted();
          // Coalesce complete blocks already buffered in `pending` into one zero-copy slice so
          // native zstd decompression is not woken separately for 3-byte block headers.
          let batchEnd = 0;
          while (pending.length - batchEnd >= 3) {
            const block = pending.readUIntLE(batchEnd, 3);
            const type = (block >> 1) & 3;
            if (type === 3) throw new Error("Reserved Codex zstd block");
            const blockSize = block >>> 3;
            if (blockSize > BLOCK_SIZE) throw new Error("Invalid Codex zstd block size");
            const step = 3 + (type === 1 ? 1 : blockSize);
            if (pending.length - batchEnd < step) break;
            batchEnd += step;
            if (block & 1) {
              done = true;
              break;
            }
          }
          if (batchEnd > 0) {
            const batch = pending.subarray(0, batchEnd);
            pending = pending.subarray(batchEnd);
            yield batch;
            if (done) break;
          }
          const blockBytes = await readExact(3);
          const block = blockBytes.readUIntLE(0, 3);
          const type = (block >> 1) & 3;
          if (type === 3) throw new Error("Reserved Codex zstd block");
          const blockSize = block >>> 3;
          if (blockSize > BLOCK_SIZE) throw new Error("Invalid Codex zstd block size");
          const body = await readExact(type === 1 ? 1 : blockSize);
          yield Buffer.concat([blockBytes, body], 3 + body.length);
          if (block & 1) break;
        }
        if (descriptor & 4) yield await readExact(4);
      }
      const frame = Readable.from(frameChunks(), { objectMode: false });
      const decoder = createZstdDecompress({
        chunkSize: BLOCK_SIZE,
        params: { [zstdConstants.ZSTD_d_windowLogMax]: 27 },
      });
      const completed = pipeline(frame, decoder, { signal }).then(
        () => null,
        (error) => error,
      );
      try {
        for await (const chunk of decoder) {
          signal.throwIfAborted();
          yield chunk as Buffer;
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

function copyEdgeBytes(
  parts: readonly Buffer[],
  total: number,
  take: number,
  head: boolean,
): Buffer {
  const length = Math.min(total, take);
  const out = Buffer.allocUnsafe(length);
  if (head) {
    let offset = 0;
    for (const part of parts) {
      const count = Math.min(part.length, length - offset);
      part.copy(out, offset, 0, count);
      offset += count;
      if (offset >= length) break;
    }
    return out;
  }
  let offset = length;
  for (let i = parts.length - 1; i >= 0 && offset > 0; i--) {
    const part = parts[i];
    if (!part) continue;
    const count = Math.min(part.length, offset);
    part.copy(out, offset - count, part.length - count, part.length);
    offset -= count;
  }
  // Skip leading UTF-8 continuation bytes so the suffix decodes cleanly from a code point boundary.
  let start = 0;
  while (start < 3 && start < out.length && ((out[start] ?? 0) & 0xc0) === 0x80) start += 1;
  return out.subarray(start);
}

/**
 * Streams newline-delimited UTF-8 lines in O(bytes) without quadratic string rescanning. When
 * `shouldDecode` is given, oversized multi-chunk lines whose 1 KiB head/tail preview cannot carry
 * usage are skipped before concatenating and UTF-8 decoding their payload.
 */
export async function* rolloutLines(
  file: string,
  signal: AbortSignal,
  shouldDecode?: (head: string, tail: string) => boolean,
): AsyncGenerator<string> {
  let parts: Buffer[] = [];
  let buffered = 0;
  const decodeMultiChunk = (): string | null => {
    if (shouldDecode && buffered > PEEK_BYTES * 2) {
      const head = copyEdgeBytes(parts, buffered, PEEK_BYTES, true).toString("utf8").slice(0, 1024);
      const tail = copyEdgeBytes(parts, buffered, PEEK_BYTES, false).toString("utf8").slice(-1024);
      if (!shouldDecode(head, tail)) {
        parts = [];
        buffered = 0;
        return null;
      }
    }
    const [single] = parts;
    const line = (single && parts.length === 1 ? single : Buffer.concat(parts, buffered)).toString(
      "utf8",
    );
    parts = [];
    buffered = 0;
    return line;
  };

  for await (const chunk of rolloutBytes(file, signal)) {
    let start = 0;
    let end: number;
    while ((end = chunk.indexOf(0x0a, start)) >= 0) {
      const slice = chunk.subarray(start, end);
      if (buffered === 0) {
        if (slice.length > MAX_LINE) throw new Error("Codex rollout line exceeds the safety limit");
        if (shouldDecode && slice.length > PEEK_BYTES * 2) {
          const head = slice.subarray(0, PEEK_BYTES).toString("utf8").slice(0, 1024);
          let tailStart = slice.length - PEEK_BYTES;
          while (tailStart < slice.length && ((slice[tailStart] ?? 0) & 0xc0) === 0x80)
            tailStart += 1;
          const tail = slice.subarray(tailStart).toString("utf8").slice(-1024);
          if (!shouldDecode(head, tail)) {
            start = end + 1;
            continue;
          }
        }
        yield slice.toString("utf8");
      } else {
        buffered += slice.length;
        if (buffered > MAX_LINE) throw new Error("Codex rollout line exceeds the safety limit");
        if (slice.length > 0) parts.push(slice);
        const decoded = decodeMultiChunk();
        if (decoded !== null) yield decoded;
      }
      start = end + 1;
    }
    if (start < chunk.length) {
      const rest = chunk.subarray(start);
      buffered += rest.length;
      if (buffered > MAX_LINE) throw new Error("Codex rollout line exceeds the safety limit");
      parts.push(rest);
    }
  }
  if (buffered > 0) {
    const decoded = decodeMultiChunk();
    if (decoded !== null && decoded.trim()) yield decoded;
  }
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
