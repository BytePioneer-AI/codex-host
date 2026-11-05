import { describe, expect, it } from "vitest";
import { PiContentStream } from "../src/pi-content-stream.js";

describe("Pi authoritative content reconciliation", () => {
  it.each(["text", "reasoning"] as const)(
    "appends a final %s suffix once with legacy unindexed deltas",
    (kind) => {
      const stream = new PiContentStream(kind);
      expect(stream.append(undefined, "prefix")).toBe("prefix");
      expect(stream.finalize([{ index: 0, text: "prefix suffix" }])).toBe(" suffix");
      expect(stream.finalize([{ index: 0, text: "prefix suffix" }])).toBe("");
    },
  );

  it("uses unindexed end events as legacy block boundaries", () => {
    const stream = new PiContentStream("reasoning");
    expect(stream.append(undefined, "first\n\n")).toBe("first");
    expect(stream.complete(undefined, "first suffix")).toBe(" suffix");
    expect(stream.append(undefined, "second\n\n")).toBe("second");
    expect(stream.complete(undefined, "second")).toBe("");
    expect(
      stream.finalize([
        { index: 0, text: "first suffix" },
        { index: 3, text: "second" },
      ]),
    ).toBe("");
  });

  it("compares each block with its own end content before the next block", () => {
    const stream = new PiContentStream("text");
    expect(stream.append(0, "first")).toBe("first");
    expect(stream.complete(0, "first end")).toBe(" end");
    expect(stream.append(2, "next")).toBe("next");
    expect(stream.complete(2, "next end")).toBe(" end");
    expect(
      stream.finalize([
        { index: 0, text: "first end" },
        { index: 2, text: "next end" },
      ]),
    ).toBe("");
  });

  it("retains internal summary paragraphs while discarding only provider-removed trailing breaks", () => {
    const stream = new PiContentStream("reasoning");
    expect(stream.append(0, "first\n\n")).toBe("first");
    expect(stream.append(0, "second\n\n")).toBe("\n\nsecond");
    expect(stream.complete(0, "first\n\nsecond")).toBe("");
    expect(stream.complete(1, "last\n")).toBe("last\n");
    expect(
      stream.finalize([
        { index: 0, text: "first\n\nsecond" },
        { index: 1, text: "last\n" },
      ]),
    ).toBe("");
  });

  it.each(["text", "reasoning"] as const)(
    "does not silently rewrite already emitted %s",
    (kind) => {
      const stream = new PiContentStream(kind);
      stream.append(0, "shown");
      expect(() => stream.complete(0, "changed")).toThrow(
        "conflicts with already streamed content",
      );
    },
  );

  it("buffers a later block so finalization can recover an earlier missing suffix in order", () => {
    const stream = new PiContentStream("text");
    expect(stream.append(0, "first")).toBe("first");
    expect(stream.append(1, "next")).toBe("");
    expect(
      stream.finalize([
        { index: 0, text: "first suffix" },
        { index: 1, text: "next" },
      ]),
    ).toBe(" suffixnext");
  });

  it("accepts interleaved block deltas without emitting later blocks before earlier ones", () => {
    const stream = new PiContentStream("text");
    expect(stream.append(0, "first")).toBe("first");
    expect(stream.append(2, "second")).toBe("");
    expect(stream.append(0, " prefix")).toBe(" prefix");
    expect(stream.complete(0, "first prefix suffix")).toBe(" suffixsecond");
    expect(stream.append(2, " suffix")).toBe(" suffix");
    expect(
      stream.finalize([
        { index: 0, text: "first prefix suffix" },
        { index: 2, text: "second suffix" },
      ]),
    ).toBe("");
  });

  it("rejects a late rewrite of a completed block once a later block has been displayed", () => {
    const stream = new PiContentStream("text");
    stream.complete(0, "first");
    stream.append(1, "next");
    expect(() =>
      stream.finalize([
        { index: 0, text: "first suffix" },
        { index: 1, text: "next" },
      ]),
    ).toThrow("conflicts");
  });

  it("recovers a missing final block without duplicating earlier blocks", () => {
    const stream = new PiContentStream("text");
    stream.append(0, "first");
    expect(
      stream.finalize([
        { index: 0, text: "first" },
        { index: 2, text: "last" },
      ]),
    ).toBe("last");
  });
});
