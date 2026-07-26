import { describe, expect, it } from "vitest";

import { StrictJsonlDecoder } from "./jsonl.mjs";

function decodeWithOptions(chunks, options) {
  const frames = [];
  const decoder = new StrictJsonlDecoder(
    (line, metadata) => frames.push({ line, metadata }),
    options,
  );
  for (const chunk of chunks) decoder.push(chunk);
  decoder.end();
  return frames;
}

function decode(chunks) {
  return decodeWithOptions(chunks);
}

describe("Gate C strict LF JSONL decoder", () => {
  it("splits only on byte LF across arbitrary chunks and UTF-8 boundaries", () => {
    const bytes = Buffer.from('{"value":"alpha\\u2028beta 漢字"}\n{"value":2}\n', "utf8");
    const chunks = [...bytes].map((byte) => Buffer.from([byte]));
    expect(decode(chunks).map(({ line }) => JSON.parse(line))).toEqual([
      { value: "alpha\u2028beta 漢字" },
      { value: 2 },
    ]);
  });

  it("accepts CRLF and reports an unterminated final frame", () => {
    expect(decode([Buffer.from('{"a":1}\r\n{"b":2}')])).toEqual([
      { line: '{"a":1}', metadata: { unterminated: false } },
      { line: '{"b":2}', metadata: { unterminated: true } },
    ]);
  });

  it("rejects a frame that exceeds the configured byte limit", () => {
    const decoder = new StrictJsonlDecoder(() => {}, { maxFrameBytes: 8 });
    expect(() => decoder.push(Buffer.from("123456789"))).toThrow(
      expect.objectContaining({ code: "FRAME_TOO_LARGE" }),
    );
  });

  it("accepts a frame exactly at the configured byte limit", () => {
    expect(decodeWithOptions([Buffer.from("12345678\n")], { maxFrameBytes: 8 })).toEqual([
      { line: "12345678", metadata: { unterminated: false } },
    ]);
  });

  it("rejects invalid UTF-8 without replacing bytes", () => {
    const decoder = new StrictJsonlDecoder(() => {});
    expect(() => decoder.push(Buffer.from([0xff, 0x0a]))).toThrow();
  });
});
