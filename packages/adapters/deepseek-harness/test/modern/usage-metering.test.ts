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
        // First non-empty reasoning fragment, as dsh's own decode time; not the block start.
        startedAtMs: 1_000_100,
        completedAtMs: 1_000_900,
      },
    });
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
