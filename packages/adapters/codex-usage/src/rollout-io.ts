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
import { promisify } from "node:util";
import { zstdDecompress } from "node:zlib";

const decompress = promisify(zstdDecompress);
const MAX_FRAME = 64 * 1024 * 1024;
const MAX_LINE = 128 * 1024 * 1024;

/** A complete Zstandard frame, not a search for magic bytes inside compressed payload. */
function frameSize(data: Buffer): { size: number; skip: boolean } | null {
  if (data.length < 8) return null;
  const magic = data.readUInt32LE(0);
  if ((magic & 0xfffffff0) === 0x184d2a50) {
    const size = 8 + data.readUInt32LE(4);
    if (size > MAX_FRAME) throw new Error("Codex zstd frame exceeds the safety limit");
    return data.length >= size ? { size, skip: true } : null;
  }
  if (magic !== 0xfd2fb528) throw new Error("Invalid Codex zstd frame");
  const descriptor = data.readUInt8(4);
  if (descriptor & 8) throw new Error("Reserved Codex zstd frame header");
  const single = (descriptor >> 5) & 1;
  let offset =
    5 +
    (single ? 0 : 1) +
    ([0, 1, 2, 4][descriptor & 3] ?? 0) +
    ([single, 2, 4, 8][descriptor >> 6] ?? 0);
  for (;;) {
    if (offset + 3 > data.length) return null;
    const block = data.readUIntLE(offset, 3);
    const type = (block >> 1) & 3;
    if (type === 3) throw new Error("Reserved Codex zstd block");
    offset += 3 + (type === 1 ? 1 : block >>> 3);
    if (offset > MAX_FRAME) throw new Error("Codex zstd frame exceeds the safety limit");
    if (block & 1) break;
  }
  if (descriptor & 4) offset += 4;
  return data.length >= offset ? { size: offset, skip: false } : null;
}

/** Node's zstd stream/sync APIs stop at the first frame; decode concatenated frames explicitly. */
export async function* rolloutBytes(file: string, signal: AbortSignal): AsyncGenerator<Buffer> {
  signal.throwIfAborted();
  const stream = createReadStream(file, { signal });
  let pending = Buffer.alloc(0);
  try {
    for await (const value of stream) {
      signal.throwIfAborted();
      const chunk = value as Buffer;
      if (!file.endsWith(".zst")) {
        yield chunk;
        continue;
      }
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const frame = frameSize(pending);
        if (!frame) break;
        if (!frame.skip) {
          const decoded = await decompress(pending.subarray(0, frame.size), {
            maxOutputLength: 128 * 1024 * 1024,
          });
          signal.throwIfAborted();
          yield decoded;
        }
        pending = pending.subarray(frame.size);
      }
      if (pending.length > MAX_FRAME) throw new Error("Codex zstd frame exceeds the safety limit");
    }
    if (pending.length) throw new Error("Truncated Codex zstd rollout");
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
