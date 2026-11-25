import { describe, expect, it } from "vitest";

import type { ModernJournalEvent } from "../../src/modern/journal.js";
import { deepSeekUsageHistory, deepSeekUsageRecord } from "../../src/modern/usage-metering.js";

// Shapes captured from a live dsh V4 journal (`session/page`), texts shortened.
function settled(
  seq: number,
  id: string,
  usage: Record<string, number> | undefined,
  extra: Record<string, unknown> = {},
): ModernJournalEvent {
  return {
    seq,
    time: 1_000_900,
    type: "assistant/message",
    surfaceOp: "append",
    data: {
      turn: 1,
      step: seq,
      message: {
        role: "assistant",
        id,
        content: [{ type: "reasoning", text: "The user" }],
        source: { kind: "model", provider: "deepseek-official", model: "deepseek-flash" },
      },
      stream: [
        {
          type: "chunk",
          time: 1_000_000,
          chunk: { type: "block-start", index: 0, blockType: "reasoning" },
        },
        {
          type: "reasoning-chunks",
          time0: 1_000_100,
          index: 0,
          dt: [5],
          texts: ["The", " user"],
        },
        {
          type: "chunk",
          time: 1_000_890,
          chunk: { type: "block-end", index: 0, block: { type: "reasoning", text: "The user" } },
        },
        ...(usage ? [{ type: "chunk", time: 1_000_890, chunk: { type: "usage", usage } }] : []),
      ],
      ...extra,
    },
  } as unknown as ModernJournalEvent;
}

function chunk(time: number, value: Record<string, unknown>) {
  return { type: "chunk", time, chunk: value };
}

function requestFor(
  stream: unknown[],
  usageOverrides: Record<string, number> = {},
  completedAtMs = 31_000,
) {
  const event = settled(17, "msg-timing", undefined, {
    stream,
    usage: { ...usage, ...usageOverrides },
  });
  const record = deepSeekUsageRecord({ ...event, time: completedAtMs }, false);
  expect(record.kind).toBe("request");
  if (record.kind !== "request") throw new Error("Expected a metered request");
  return record.request;
}

function outputSpeed(request: ReturnType<typeof requestFor>): number {
  if (request.startedAtMs === undefined || request.completedAtMs === undefined)
    throw new Error("Expected a trustworthy output interval");
  return request.outputTokens / ((request.completedAtMs - request.startedAtMs) / 1_000);
}

const usage = {
  inputTokens: 10726,
  outputTokens: 326,
  cacheReadTokens: 768,
  cacheWriteTokens: 0,
  totalTokens: 11820,
};

describe("DeepSeek Harness usage records", () => {
  it("adds cache back into input and times from the first token to settlement", () => {
    expect(deepSeekUsageRecord(settled(17, "msg-1", usage), false)).toEqual({
      kind: "request",
      request: {
        requestId: "msg-1",
        model: "deepseek-flash",
        inputTokens: 11494,
        cachedInputTokens: 768,
        cacheWriteInputTokens: 0,
        outputTokens: 326,
        startedAtMs: 1_000_000,
        completedAtMs: 1_000_900,
      },
    });
  });

  it.each([800, undefined])(
    "times hidden reasoning from its block start (split: %s)",
    (reasoning) => {
      const request = requestFor(
        [
          chunk(1_000, { type: "block-start", index: 0, blockType: "reasoning" }),
          chunk(21_000, { type: "text-delta", index: 1, text: "answer" }),
        ],
        { outputTokens: 1_200, ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }) },
      );
      expect(request).toMatchObject({
        startedAtMs: 1_000,
        completedAtMs: 31_000,
        outputTokens: 1_200,
      });
      expect(outputSpeed(request)).toBe(40);
    },
  );

  it("includes observable reasoning timing in the DSH 0.2.2-rc.1 sample", () => {
    // Sanitized native-evidence.json timestamps/counts; shortened bodies, not a live request.
    const request = requestFor(
      [
        chunk(1_794_764_068_845, { type: "block-start", index: 0, blockType: "reasoning" }),
        {
          type: "reasoning-chunks",
          time0: 1_794_764_068_846,
          index: 0,
          dt: [],
          texts: ["thinking"],
        },
        chunk(1_794_764_069_762, { type: "text-delta", index: 1, text: "answer" }),
      ],
      { inputTokens: 10_969, outputTokens: 505, cacheReadTokens: 0, totalTokens: 11_474 },
      1_794_764_071_045,
    );
    expect(request).toMatchObject({
      startedAtMs: 1_794_764_068_845,
      completedAtMs: 1_794_764_071_045,
      outputTokens: 505,
    });
    expect(request.reasoningOutputTokens).toBeUndefined();
    expect(outputSpeed(request)).toBeCloseTo(505 / 2.2, 10);
  });

  it.each([
    { type: "text-delta", index: 0, text: "answer" },
    { type: "tool-call-delta", index: 0, id: "call", name: "read", argumentsDelta: "{" },
    { type: "reasoning-delta", index: 0, text: "" },
    { type: "block-end", index: 0, block: { type: "reasoning", text: "assembled thinking" } },
  ])("retains known reasoning usage without timing when its start is absent %#", (value) => {
    const request = requestFor([chunk(21_000, value)], {
      outputTokens: 1_200,
      reasoningTokens: 800,
    });
    expect(request).toMatchObject({ outputTokens: 1_200, reasoningOutputTokens: 800 });
    expect(request.startedAtMs).toBeUndefined();
    expect(request.completedAtMs).toBeUndefined();
  });

  it.each([0, undefined])("preserves text-only timing (reasoning split: %s)", (reasoning) => {
    const request = requestFor(
      [
        chunk(1_000, { type: "block-start", index: 0, blockType: "text" }),
        chunk(2_000, { type: "text-delta", index: 0, text: "" }),
        { type: "text-chunks", time0: 21_000, index: 0, dt: [], texts: ["answer"] },
      ],
      reasoning === undefined ? {} : { reasoningTokens: reasoning },
    );
    expect(request).toMatchObject({ startedAtMs: 21_000, completedAtMs: 31_000 });
  });

  it("accepts observable reasoning without a block start", () => {
    const request = requestFor(
      [chunk(1_000, { type: "reasoning-delta", index: 0, text: "thinking" })],
      { reasoningTokens: 100 },
    );
    expect(request).toMatchObject({ startedAtMs: 1_000, completedAtMs: 31_000 });
  });

  it("uses a block start when its only reasoning delta is empty", () => {
    const request = requestFor([
      chunk(1_000, { type: "block-start", index: 0, blockType: "reasoning" }),
      chunk(21_000, { type: "reasoning-delta", index: 0, text: "" }),
    ]);
    expect(request.startedAtMs).toBe(1_000);
  });

  it("uses the earliest reasoning start even when its visible delta arrives much later", () => {
    const request = requestFor(
      [
        chunk(1_000, { type: "block-start", index: 0, blockType: "reasoning" }),
        chunk(21_000, { type: "reasoning-delta", index: 0, text: "visible thinking" }),
        chunk(25_000, { type: "text-delta", index: 1, text: "answer" }),
      ],
      { outputTokens: 1_200, reasoningTokens: 800 },
    );
    expect(request).toMatchObject({ startedAtMs: 1_000, completedAtMs: 31_000 });
    expect(outputSpeed(request)).toBe(40);
  });

  it("uses a hidden block's start even if a later reasoning block has visible deltas", () => {
    const request = requestFor([
      chunk(1_000, { type: "block-start", index: 0, blockType: "reasoning" }),
      chunk(21_000, { type: "reasoning-delta", index: 1, text: "later thinking" }),
    ]);
    expect(request.startedAtMs).toBe(1_000);
  });

  it.each([
    [],
    [chunk(1_000, { type: "block-start", index: 0, blockType: "text" })],
    [chunk(1_000, { type: "text-delta", index: 0, text: "" })],
    [chunk(1_000, { type: "reasoning-delta", index: 0, text: "" })],
    [chunk(1_000, { type: "block-start", index: 0, blockType: "tool-call" })],
  ])("does not time empty scaffolding %#", (...stream) => {
    const request = requestFor(stream);
    expect(request.startedAtMs).toBeUndefined();
    expect(request.completedAtMs).toBeUndefined();
  });

  it.each(["{}", '{"path":"file"}', "[]", "null", '"value"', "42"])(
    "rejects an assembled tool argument (%s) even before later text",
    (argumentsDelta) => {
      const request = requestFor([
        chunk(1_000, {
          type: "tool-call-delta",
          index: 0,
          id: "call",
          name: "read",
          argumentsDelta,
        }),
        chunk(21_000, { type: "text-delta", index: 1, text: "answer" }),
      ]);
      expect(request.startedAtMs).toBeUndefined();
      expect(request.completedAtMs).toBeUndefined();
    },
  );

  it("preserves named partial tool deltas without accepting tool starts or empty arguments", () => {
    const request = requestFor([
      chunk(1_000, { type: "block-start", index: 0, blockType: "tool-call" }),
      chunk(2_000, {
        type: "tool-call-delta",
        index: 0,
        id: "call",
        name: "read",
        argumentsDelta: "",
      }),
      {
        type: "tool-call-chunks",
        time0: 21_000,
        index: 0,
        id: "call",
        name: "read",
        dt: [5],
        args: ['{"path":', '"file"}'],
      },
    ]);
    expect(request.startedAtMs).toBe(21_000);
  });

  it("does not broaden unnamed tool-delta timing", () => {
    const request = requestFor([
      chunk(1_000, { type: "tool-call-delta", index: 0, id: "call", argumentsDelta: "{" }),
    ]);
    expect(request.startedAtMs).toBeUndefined();
  });

  it("rejects complete unnamed tool arguments before later text", () => {
    const request = requestFor([
      { type: "tool-call-chunks", time0: 1_000, index: 0, id: "call", dt: [], args: ["{}"] },
      chunk(21_000, { type: "text-delta", index: 1, text: "answer" }),
    ]);
    expect(request.startedAtMs).toBeUndefined();
  });

  it.each(["reasoning", "text"])(
    "keeps an earlier %s boundary before complete tool arguments",
    (type) => {
      const request = requestFor([
        chunk(
          1_000,
          type === "reasoning"
            ? { type: "block-start", index: 0, blockType: type }
            : { type: "text-delta", index: 0, text: "answer" },
        ),
        chunk(21_000, {
          type: "tool-call-delta",
          index: 1,
          id: "call",
          name: "read",
          argumentsDelta: "{}",
        }),
      ]);
      expect(request.startedAtMs).toBe(1_000);
    },
  );

  it.each([-1, 31_000, 32_000])(
    "omits invalid/nonpositive timing but retains usage (start: %s)",
    (time) => {
      const request = requestFor([
        chunk(time, { type: "block-start", index: 0, blockType: "reasoning" }),
      ]);
      expect(request.outputTokens).toBe(usage.outputTokens);
      expect(request.startedAtMs).toBeUndefined();
      expect(request.completedAtMs).toBeUndefined();
    },
  );

  it.each([NaN, Infinity, -1, 1.5])(
    "retains usage with an invalid completion timestamp (%s)",
    (time) => {
      const request = requestFor(
        [chunk(1_000, { type: "block-start", index: 0, blockType: "reasoning" })],
        {},
        time,
      );
      expect(request.startedAtMs).toBeUndefined();
      expect(request.completedAtMs).toBeUndefined();
    },
  );

  it.each([NaN, Infinity, 1.5])(
    "keeps profile rejection of invalid stream timestamps (%s)",
    (time) => {
      expect(
        deepSeekUsageRecord(
          settled(17, "invalid", usage, {
            stream: [chunk(time, { type: "block-start", index: 0, blockType: "reasoning" })],
          }),
          false,
        ),
      ).toEqual({ kind: "missing" });
    },
  );

  it("keeps hidden reasoning history untimed and usage complete", () => {
    const history = deepSeekUsageHistory([
      settled(17, "hidden", undefined, {
        usage: { ...usage, reasoningTokens: 100 },
        stream: [chunk(1_000, { type: "block-start", index: 0, blockType: "reasoning" })],
      }),
    ]);
    expect(history.complete).toBe(true);
    expect(history.requests[0]).toMatchObject({
      requestId: "hidden",
      historical: true,
      reasoningOutputTokens: 100,
    });
    expect(history.requests[0]?.startedAtMs).toBeUndefined();
    expect(history.requests[0]?.completedAtMs).toBeUndefined();
  });

  it("replays history without timing and treats an interrupted message as no usage", () => {
    expect(
      deepSeekUsageHistory([
        settled(17, "msg-1", usage),
        settled(18, "msg-2", undefined, { interrupted: true }),
        { seq: 19, time: 1, type: "step/end", data: { turn: 1, step: 1 } } as ModernJournalEvent,
      ]),
    ).toEqual({
      requests: [
        expect.objectContaining({ requestId: "msg-1", historical: true, inputTokens: 11494 }),
      ],
      complete: true,
    });
    expect(deepSeekUsageHistory([settled(18, "msg-2", undefined)]).complete).toBe(false);
  });
});
