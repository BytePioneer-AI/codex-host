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

  it("applies optional limits per frame rather than per transport chunk", async () => {
    const frames: string[] = [];
    for await (const frame of readLfFrames(Readable.from(["1234\n12\n", "34", "56\n"]), {
      maxFrameBytes: 4,
    }))
      frames.push(frame.toString());
    expect(frames).toEqual(["1234", "12", "3456"]);
  });

  it.each([["12345\n"], ["123", "45"]])(
    "rejects oversized frames with or without a newline (%j)",
    async (...chunks) => {
      await expect(async () => {
        for await (const frame of readLfFrames(Readable.from(chunks), { maxFrameBytes: 4 }))
          expect(frame).toBeDefined();
      }).rejects.toThrow("exceeds its limit");
    },
  );

  it("rejects a backpressured write when the stream closes before draining", async () => {
    const output = new PassThrough({ highWaterMark: 1 });
    const write = writeFrame(output, Buffer.from("{}"));

    output.destroy();

    const outcome = await Promise.race([
      write.catch((error: unknown) => error),
      new Promise<"timed-out">((resolve) => {
        setTimeout(() => resolve("timed-out"), 100);
      }),
    ]);
    expect(outcome).toBeInstanceOf(Error);
  });
});
