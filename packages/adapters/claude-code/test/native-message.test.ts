import { describe, expect, it } from "vitest";

import { ClaudeNativeTurnAccumulator } from "../src/native-message.js";

function partial(text: string, uuid = "assistant-1") {
  return {
    type: "stream_event",
    uuid,
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  };
}

function thinkingPartial(thinking: string, uuid = "assistant-1") {
  return {
    type: "stream_event",
    uuid,
    event: {
      type: "content_block_delta",
      delta: { type: "thinking_delta", thinking },
    },
  };
}

function assistant(text: string, error?: string, uuid = "assistant-1") {
  return assistantBlocks([{ type: "text", text }], uuid, error);
}

function assistantBlocks(content: unknown[], uuid: string, error?: string) {
  return {
    type: "assistant",
    uuid,
    message: { content },
    ...(error ? { error } : {}),
  };
}

function toolUse(name: string) {
  return {
    type: "assistant",
    message: { content: [{ type: "tool_use", name, id: "synthetic-tool", input: {} }] },
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

    expect(turn.consume(partial("hello")).events).toEqual([{ type: "text.delta", delta: "hello" }]);
    expect(turn.consume(partial(" world")).events).toEqual([
      { type: "text.delta", delta: " world" },
    ]);
    expect(turn.consume(assistant("hello world!"))).toEqual({
      events: [{ type: "text.delta", delta: "!" }],
    });
    expect(turn.consume(result()).terminal).toEqual({ status: "succeeded" });
  });

  it("uses a complete Assistant message when partial streaming is absent", () => {
    const turn = new ClaudeNativeTurnAccumulator();

    expect(turn.consume(assistant("complete text"))).toEqual({
      events: [{ type: "text.delta", delta: "complete text" }],
    });
    expect(turn.consume(result()).terminal).toEqual({ status: "succeeded" });
  });

  it("reconciles separate Assistant text responses across a Tool loop", () => {
    const turn = new ClaudeNativeTurnAccumulator();

    expect(turn.consume(partial("before"))).toEqual({
      events: [{ type: "text.delta", delta: "before" }],
    });
    expect(turn.consume(assistant("before tool\n"))).toEqual({
      events: [{ type: "text.delta", delta: " tool\n" }],
    });
    expect(turn.consume(toolUse("Edit"))).toEqual({ events: [] });
    expect(turn.consume(partial("after", "assistant-2"))).toEqual({
      events: [{ type: "text.delta", delta: "after" }],
    });
    expect(turn.consume(assistant("after denial", undefined, "assistant-2"))).toEqual({
      events: [{ type: "text.delta", delta: " denial" }],
    });
    expect(turn.consume(result()).terminal).toEqual({ status: "succeeded" });
  });

  it("fails rather than replaying conflicting native text", () => {
    const turn = new ClaudeNativeTurnAccumulator();

    turn.consume(partial("first"));
    expect(turn.consume(assistant("different"))).toEqual({ events: [] });
    expect(turn.consume(result()).terminal).toEqual({ status: "failed", kind: "textConflict" });
  });

  it("reconciles visible thinking when stream and complete wrapper UUIDs differ", () => {
    const turn = new ClaudeNativeTurnAccumulator();

    expect(turn.consume(thinkingPartial("visible ", "assistant-thinking")).events).toEqual([
      {
        type: "reasoning.delta",
        messageId: "assistant-thinking",
        delta: "visible ",
      },
    ]);
    expect(
      turn.consume(
        assistantBlocks(
          [
            { type: "thinking", thinking: "visible reasoning", signature: "ignored" },
            { type: "text", text: "answer" },
          ],
          "assistant-complete",
        ),
      ).events,
    ).toEqual([
      { type: "reasoning.delta", messageId: "assistant-thinking", delta: "reasoning" },
      { type: "reasoning.completed", messageId: "assistant-thinking" },
      { type: "text.delta", delta: "answer" },
    ]);
    expect(turn.consume(result()).terminal).toEqual({ status: "succeeded" });
  });

  it("publishes final-only thinking and ignores protected thinking forms", () => {
    const turn = new ClaudeNativeTurnAccumulator();

    expect(
      turn.consume(
        assistantBlocks(
          [
            { type: "thinking", thinking: "displayable", signature: "not-projected" },
            { type: "redacted_thinking", data: "encrypted" },
            { type: "text", text: "answer" },
          ],
          "final-only-thinking",
        ),
      ).events,
    ).toEqual([
      {
        type: "reasoning.delta",
        messageId: "final-only-thinking",
        delta: "displayable",
      },
      { type: "reasoning.completed", messageId: "final-only-thinking" },
      { type: "text.delta", delta: "answer" },
    ]);
  });

  it("keeps reasoning reconciliation isolated across Assistant messages", () => {
    const turn = new ClaudeNativeTurnAccumulator();

    expect(
      turn.consume(assistantBlocks([{ type: "thinking", thinking: "first" }], "assistant-first"))
        .events,
    ).toEqual([
      { type: "reasoning.delta", messageId: "assistant-first", delta: "first" },
      { type: "reasoning.completed", messageId: "assistant-first" },
    ]);
    expect(
      turn.consume(assistantBlocks([{ type: "thinking", thinking: "second" }], "assistant-second"))
        .events,
    ).toEqual([
      { type: "reasoning.delta", messageId: "assistant-second", delta: "second" },
      { type: "reasoning.completed", messageId: "assistant-second" },
    ]);
  });

  it("fails rather than replacing conflicting complete reasoning", () => {
    const turn = new ClaudeNativeTurnAccumulator();

    turn.consume(thinkingPartial("streamed", "reasoning-conflict"));
    expect(
      turn.consume(
        assistantBlocks(
          [{ type: "thinking", thinking: "different", signature: "ignored" }],
          "reasoning-conflict",
        ),
      ).events,
    ).toEqual([]);
    expect(turn.consume(result()).terminal).toEqual({
      status: "failed",
      kind: "reasoningConflict",
    });
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
    expect(turn.consume({ type: "future_event", native: true })).toEqual({ events: [] });
    expect(turn.consume(result()).terminal).toEqual({ status: "succeeded" });
  });
});
