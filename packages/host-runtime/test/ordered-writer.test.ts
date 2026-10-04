import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import { OrderedWriter } from "../src/ordered-writer.js";

const delta = (text: string, params: JsonObject = {}, envelope: JsonObject = {}): JsonObject => ({
  method: "item/agentMessage/delta",
  params: { threadId: "native", turnId: "turn", itemId: "item", delta: text, ...params },
  ...envelope,
});

function fixture(batchMs = 16) {
  const stream = new PassThrough();
  const output: string[] = [];
  stream.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  const writer = new OrderedWriter(stream, undefined, batchMs);
  return {
    writer,
    write: (value: JsonObject) => writer.frame(Buffer.from(JSON.stringify(value)), value),
    messages: () =>
      output
        .join("")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    raw: () => output.join(""),
  };
}

afterEach(() => vi.useRealTimers());

describe("native text delta batching", () => {
  it("backpressures the native reader when four timed batches are blocked", async () => {
    vi.useFakeTimers();
    const callbacks: Array<() => void> = [];
    const output: Buffer[] = [];
    const stream = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, done) {
        output.push(Buffer.from(chunk));
        callbacks.push(done);
      },
    });
    const writer = new OrderedWriter(stream);
    for (let index = 0; index < 4; index++) {
      const value = delta(String(index));
      await writer.frame(Buffer.from(JSON.stringify(value)), value);
      await vi.advanceTimersByTimeAsync(16);
    }
    let accepted = false;
    const value = delta("4");
    const blocked = writer.frame(Buffer.from(JSON.stringify(value)), value).then(() => {
      accepted = true;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(accepted).toBe(false);
    expect(output).toHaveLength(1);
    for (let index = 0; index < 4; index++) {
      expect(callbacks).toHaveLength(1);
      callbacks.shift()?.();
      await vi.advanceTimersByTimeAsync(0);
    }
    await blocked;
    await vi.advanceTimersByTimeAsync(16);
    callbacks.shift()?.();
    await writer.drain();
    const messages = Buffer.concat(output)
      .toString()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(messages.map((message) => message.params.delta)).toEqual(["0", "1", "2", "3", "4"]);
    stream.destroy();
  });

  it("preserves a 1000-fragment Unicode response before the completion barrier", async () => {
    const f = fixture();
    const fragments = Array.from({ length: 1000 }, (_, index) => `空投${index}🙂\n`);
    for (const fragment of fragments) await f.write(delta(fragment));
    const completed = {
      method: "item/completed",
      params: { threadId: "native", turnId: "turn", item: { id: "item" } },
    };
    await f.writer.json(completed);
    expect(f.messages()).toEqual([delta(fragments.join("")), completed]);
  });

  it("flushes on the original deadline even under continuous input", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.write(delta("a"));
    await vi.advanceTimersByTimeAsync(15);
    await f.write(delta("b"));
    expect(f.messages()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.messages()).toEqual([delta("ab")]);
    await f.writer.drain();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { threadId: "other" },
    { turnId: "other" },
    { itemId: "other" },
    { summaryIndex: 1 },
    { contentIndex: 2 },
    { extraNativeField: "new" },
  ])("does not merge a different native identity or index: %j", async (params) => {
    const f = fixture();
    await f.write(delta("a"));
    await f.write(delta("b", params));
    await f.writer.drain();
    expect(f.messages()).toEqual([delta("a"), delta("b", params)]);
  });

  it("preserves envelope metadata and method changes", async () => {
    const f = fixture();
    const reasoning = delta("b", {}, { method: "item/reasoning/textDelta" });
    const stamped = delta("c", {}, { emittedAtMs: 5 });
    await f.write(delta("a"));
    await f.write(reasoning);
    await f.write(stamped);
    await f.writer.drain();
    expect(f.messages()).toEqual([delta("a"), reasoning, stamped]);
  });

  it.each([
    { method: "error", params: { message: "Failure" } },
    { id: 12, result: {} },
    { id: "approval", method: "item/commandExecution/requestApproval", params: {} },
    { method: "item/commandExecution/outputDelta", params: { delta: "tool" } },
  ])("flushes before non-text native traffic: %j", async (barrier) => {
    const f = fixture();
    await f.write(delta("a"));
    await f.write(barrier);
    await f.write(delta("b"));
    await f.writer.drain();
    expect(f.messages()).toEqual([delta("a"), barrier, delta("b")]);
  });

  it("bounds a burst without dropping fragments and flushes on shutdown", async () => {
    const f = fixture();
    const text = "x".repeat(40_000);
    await f.write(delta(text));
    await f.write(delta(text));
    await f.write(delta("tail"));
    await f.writer.drain();
    const messages = f.messages();
    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.params.delta).join("")).toBe(text + text + "tail");
  });

  it("forwards disabled batching and unknown delta formats verbatim", async () => {
    const f = fixture(0);
    const raw = Buffer.from('{ "method" : "item/agentMessage/delta", "params": {"delta":"text"} }');
    await f.writer.frame(raw, JSON.parse(raw.toString()));
    await f.writer.drain();
    expect(f.raw()).toBe(raw.toString() + "\n");
  });
});
