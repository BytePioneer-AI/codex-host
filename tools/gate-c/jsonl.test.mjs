import { describe, expect, it } from "vitest";

import { StrictJsonlDecoder } from "./jsonl.mjs";

function decode(chunks) {
  const frames = [];
  const decoder = new StrictJsonlDecoder((line, metadata) => frames.push({ line, metadata }));
  for (const chunk of chunks) decoder.push(chunk);
  decoder.end();
  return frames;
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

  it("rejects invalid UTF-8 without replacing bytes", () => {
    const decoder = new StrictJsonlDecoder(() => {});
    expect(() => decoder.push(Buffer.from([0xff, 0x0a]))).toThrow();
  });
});
