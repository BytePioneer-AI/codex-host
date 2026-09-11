import { describe, expect, it } from "vitest";

import { CodeBuddyTurnAccumulator, type CodeBuddyTurnProjection } from "../src/turn-accumulator.js";
import type { CodeBuddyStreamFrame } from "../src/stream-protocol.js";

function accumulate(frames: CodeBuddyStreamFrame[]): CodeBuddyTurnProjection[] {
  const projections: CodeBuddyTurnProjection[] = [];
  const accumulator = new CodeBuddyTurnAccumulator((projection) => projections.push(projection));
  for (const frame of frames) accumulator.handleFrame(frame);
  return projections;
}

const INIT_FRAME: CodeBuddyStreamFrame = {
  type: "system",
  subtype: "init",
  session_id: "s-1",
  model: "gpt-5.6-sol",
  permissionMode: "default",
};

describe("CodeBuddyTurnAccumulator", () => {
  it("projects init frames", () => {
    expect(accumulate([INIT_FRAME])).toEqual([
      { kind: "init", info: { sessionId: "s-1", model: "gpt-5.6-sol", permissionMode: "default" } },
    ]);
  });

  it("streams text and thinking deltas from stream_event frames", () => {
    const projections = accumulate([
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hel" },
        },
      },
      {
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
      },
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "thinking_delta", thinking: "hmm" },
        },
      },
      { type: "stream_event", event: { type: "content_block_start", index: 2 } },
      {
        type: "stream_event",
        event: { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "" } },
      },
    ]);
    expect(projections).toEqual([
      { kind: "text.delta", delta: "Hel" },
      { kind: "text.delta", delta: "lo" },
      { kind: "reasoning.delta", delta: "hmm" },
    ]);
  });

  it("projects tool calls from assistant frames and results from user frames", () => {
    const projections = accumulate([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "fallback text" },
            { type: "tool_use", id: "call-1", name: "Bash", input: { command: "ls" } },
          ],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call-1",
              content: [{ type: "text", text: "file-a\nfile-b" }],
              is_error: false,
            },
            { type: "tool_result", tool_use_id: "missing", content: "ignored" },
          ],
        },
      },
    ]);
    expect(projections).toEqual([
      { kind: "text.delta", delta: "fallback text" },
      { kind: "tool.started", callId: "call-1", toolName: "Bash", input: { command: "ls" } },
      { kind: "tool.completed", callId: "call-1", outputText: "file-a\nfile-b", isError: false },
      // Results without a matching tool_use id are still projected; the
      // adapter drops the ones it cannot pair with a started item.
      { kind: "tool.completed", callId: "missing", outputText: "ignored", isError: false },
    ]);
  });

  it("suppresses the assistant text fallback once real deltas were streamed", () => {
    const projections = accumulate([
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "live" },
        },
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "live" }] },
      },
    ]);
    expect(projections).toEqual([{ kind: "text.delta", delta: "live" }]);
  });

  it("maps terminal result frames, treating error flags and subtypes as failures", () => {
    const ok = accumulate([
      {
        type: "result",
        subtype: "success",
        result: "done",
        session_id: "s-1",
        total_cost_usd: 0.02,
      },
    ]);
    expect(ok).toHaveLength(1);
    const completed = ok[0];
    if (completed?.kind !== "completed") throw new Error("expected completion");
    expect(completed.result.outcome).toBe("succeeded");
    expect(completed.result.resultText).toBe("done");
    expect(completed.result.totalCostUsd).toBe(0.02);

    const failed = accumulate([{ type: "result", subtype: "error_during_execution" }]);
    if (failed[0]?.kind !== "completed") throw new Error("expected completion");
    expect(failed[0].result.outcome).toBe("failed");
  });
});
