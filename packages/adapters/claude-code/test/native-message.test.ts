import { describe, expect, it } from "vitest";

import { ClaudeNativeTurnAccumulator } from "../src/index.js";

function partial(text: string) {
  return {
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  };
}

function assistant(text: string, error?: string) {
  return {
    type: "assistant",
    message: { content: [{ type: "text", text }] },
    ...(error ? { error } : {}),
  };
}

function result(input: Record<string, unknown> = {}) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    terminal_reason: "completed",
    ...input,
  };
}

describe("Claude native Turn interpretation", () => {
  it("deduplicates partial text and appends only the complete-message suffix", () => {
    const turn = new ClaudeNativeTurnAccumulator();

    expect(turn.consume(partial("hello")).deltas).toEqual(["hello"]);
    expect(turn.consume(partial(" world")).deltas).toEqual([" world"]);
    expect(turn.consume(assistant("hello world!"))).toEqual({ deltas: ["!"] });
    expect(turn.consume(result()).terminal).toEqual({ status: "succeeded" });
  });

  it("uses a complete Assistant message when partial streaming is absent", () => {
    const turn = new ClaudeNativeTurnAccumulator();

    expect(turn.consume(assistant("complete text"))).toEqual({ deltas: ["complete text"] });
    expect(turn.consume(result()).terminal).toEqual({ status: "succeeded" });
  });

  it("fails rather than replaying conflicting native text", () => {
    const turn = new ClaudeNativeTurnAccumulator();

    turn.consume(partial("first"));
    expect(turn.consume(assistant("different"))).toEqual({ deltas: [] });
    expect(turn.consume(result()).terminal).toEqual({ status: "failed", kind: "textConflict" });
  });

  it("does not trust subtype success when native error fields disagree", () => {
    const turn = new ClaudeNativeTurnAccumulator();

    expect(turn.consume(result({ is_error: true, terminal_reason: "api_error" })).terminal).toEqual(
      { status: "failed", kind: "native" },
    );
  });

  it("classifies authentication evidence", () => {
    const turn = new ClaudeNativeTurnAccumulator();

    turn.consume(assistant("", "authentication_failed"));
    expect(turn.consume(result({ is_error: true, terminal_reason: "api_error" })).terminal).toEqual(
      { status: "failed", kind: "authentication" },
    );
  });

  it("requires a requested cancel and authoritative aborted terminal", () => {
    const cancelled = new ClaudeNativeTurnAccumulator();
    cancelled.requestCancel();
    expect(
      cancelled.consume(
        result({
          subtype: "error_during_execution",
          is_error: true,
          terminal_reason: "aborted_streaming",
        }),
      ).terminal,
    ).toEqual({ status: "cancelled", reason: "aborted_streaming" });

    const unproven = new ClaudeNativeTurnAccumulator();
    unproven.requestCancel();
    expect(unproven.consume(result()).terminal).toEqual({
      status: "failed",
      kind: "cancellationUnproven",
    });
  });

  it("ignores unknown messages", () => {
    const turn = new ClaudeNativeTurnAccumulator();
    expect(turn.consume({ type: "future_event", native: true })).toEqual({ deltas: [] });
    expect(turn.consume(result()).terminal).toEqual({ status: "succeeded" });
  });
});
