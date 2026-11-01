import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyRelation, rolloutBytes, rolloutLines } from "../src/rollout-io.js";

const signal = new AbortController().signal;
const BLOCK_SIZE = 128 * 1024;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "codex-rollout-io-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function bytes(file: string, abort = signal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of rolloutBytes(file, abort)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// Raw and RLE blocks avoid large checked-in fixtures or costly compression.
async function largeFrame(name: string, blocks: number, rle = false) {
  const file = path.join(root, name);
  const output = await open(file, "w");
  const payload = Buffer.alloc(rle ? 1 : BLOCK_SIZE, 0x61);
  const hash = createHash("sha256");
  const decoded = rle ? Buffer.alloc(BLOCK_SIZE, 0x61) : payload;
  try {
    // Unknown content size, 2 MiB window, no dictionary or checksum.
    await output.write(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x58]));
    for (let i = 0; i < blocks; i++) {
      const header = Buffer.alloc(3);
      header.writeUIntLE((BLOCK_SIZE << 3) | (rle ? 2 : 0) | Number(i === blocks - 1), 0, 3);
      await output.writev([header, payload]);
      hash.update(decoded);
    }
  } finally {
    await output.close();
  }
  return { file, decodedBytes: blocks * BLOCK_SIZE, sha256: hash.digest("hex") };
}

describe("streaming Codex rollout reading", () => {
  it.each([
    ["compressed frame above 64 MiB", 513, false],
    ["decoded frame above 128 MiB", 1025, true],
  ])(
    "reads a %s without buffering its full output",
    async (_name, blocks, rle) => {
      const fixture = await largeFrame("large.zst", blocks, rle);
      const hash = createHash("sha256");
      let total = 0;
      let largest = 0;
      for await (const chunk of rolloutBytes(fixture.file, signal)) {
        total += chunk.length;
        largest = Math.max(largest, chunk.length);
        hash.update(chunk);
      }
      expect(total).toBe(fixture.decodedBytes);
      expect(hash.digest("hex")).toBe(fixture.sha256);
      expect(largest).toBeLessThanOrEqual(BLOCK_SIZE);
    },
    20_000,
  );

  it("keeps every frame and UTF-8 line across a skippable frame", async () => {
    const text = Buffer.from("中文😀\nsecond\n");
    const plain = path.join(root, "plain.jsonl");
    const compressed = path.join(root, "frames.zst");
    const skip = Buffer.alloc(11);
    skip.writeUInt32LE(0x184d2a50, 0);
    skip.writeUInt32LE(3, 4);
    skip.write("abc", 8);
    await writeFile(plain, text);
    await writeFile(
      compressed,
      Buffer.concat([
        zstdCompressSync(text.subarray(0, 4)),
        skip,
        zstdCompressSync(text.subarray(4)),
      ]),
    );
    expect(await bytes(compressed)).toEqual(text);
    const lines = [];
    for await (const line of rolloutLines(compressed, signal)) lines.push(line);
    expect(lines).toEqual(["中文😀", "second"]);
    expect(await copyRelation(plain, compressed, signal)).toBe("equal");
  });

  it("validates a compression tail even after proving a decoded prefix", async () => {
    const short = path.join(root, "short.jsonl");
    const long = path.join(root, "long.zst");
    await writeFile(short, "prefix\n");
    await writeFile(
      long,
      Buffer.concat([
        zstdCompressSync(Buffer.from("prefix\n")),
        zstdCompressSync(Buffer.from("suffix\n")),
      ]),
    );
    expect(await copyRelation(short, long, signal)).toBe("a-prefix");
    expect(await copyRelation(long, short, signal)).toBe("b-prefix");
    await writeFile(long, (await readFile(long)).subarray(0, -1));
    await expect(copyRelation(short, long, signal)).rejects.toThrow();
  });

  it.each([
    ["partial magic", Buffer.from([0x28, 0xb5])],
    ["partial skippable frame", Buffer.from([0x50, 0x2a, 0x4d, 0x18, 1, 0, 0, 0])],
    ["reserved block", Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0x58, 7, 0, 0])],
    ["oversized block", Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0x58, 9, 0, 0x10])],
    ["256 MiB window", Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0x90, 1, 0, 0])],
  ])("rejects %s", async (_name, data) => {
    const file = path.join(root, "invalid.zst");
    await writeFile(file, data);
    await expect(bytes(file)).rejects.toThrow();
  });

  it("cancels active decoding and closes on early iterator return", async () => {
    const { file } = await largeFrame("cancel.zst", 16, true);
    await expect(bytes(file, AbortSignal.abort())).rejects.toThrow();
    const controller = new AbortController();
    const iterator = rolloutBytes(file, controller.signal);
    expect((await iterator.next()).done).toBe(false);
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
    const early = rolloutBytes(file, signal);
    expect((await early.next()).done).toBe(false);
    await early.return(undefined);
    await expect(early.next()).resolves.toMatchObject({ done: true });
    await rm(file);
  });
});
