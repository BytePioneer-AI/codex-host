import { PassThrough, Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { parseJsonFrame, readLfFrames, writeFrame } from "../src/index.js";

describe("Protocol Core strict JSONL", () => {
  it("preserves frame bytes across arbitrary chunks", async () => {
    const frames: Buffer[] = [];
    for await (const frame of readLfFrames(
      Readable.from([Buffer.from('{"a"'), Buffer.from(":1}\n")]),
    )) {
      frames.push(frame);
    }
    expect(frames).toEqual([Buffer.from('{"a":1}')]);

    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk: Buffer) => chunks.push(chunk));
    const firstFrame = frames[0];
    if (!firstFrame) throw new Error("expected one JSONL frame");
    await writeFrame(output, firstFrame);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from('{"a":1}\n'));
  });

  it("rejects unterminated, empty, invalid UTF-8, and invalid JSON frames", async () => {
    await expect(async () => {
      for await (const frame of readLfFrames(Readable.from([Buffer.from("{}")]))) {
        expect(frame).toBeDefined();
      }
    }).rejects.toThrow("unterminated");
    expect(() => parseJsonFrame(Buffer.alloc(0))).toThrow("empty");
    expect(() => parseJsonFrame(Buffer.from([0xff]))).toThrow("invalid JSONL");
    expect(() => parseJsonFrame(Buffer.from("no-json"))).toThrow("invalid JSONL");
  });
});
