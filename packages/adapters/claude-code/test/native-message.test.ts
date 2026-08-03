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

function toolUse(name: string, id = "synthetic-tool", input: unknown = {}) {
  return {
    type: "assistant",
    uuid: `assistant-${id}`,
    message: { content: [{ type: "tool_use", name, id, input }] },
  };
}

function toolUses(...blocks: Array<{ id: string; name: string; input: unknown }>) {
  return {
    type: "assistant",
    uuid: "assistant-tools",
    message: {
      content: blocks.map(({ id, name, input }) => ({ type: "tool_use", id, name, input })),
    },
  };
}

function toolResult(
  id: string,
  input: { content?: unknown; isError?: boolean; nativeResult?: unknown } = {},
) {
  return {
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          content: input.content ?? "complete",
          ...(input.isError ? { is_error: true } : {}),
        },
      ],
    },
    ...(input.nativeResult === undefined ? {} : { tool_use_result: input.nativeResult }),
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

    expect(turn.consume(partial("hello")).events).toEqual([
      { type: "text.delta", messageId: "assistant-1", delta: "hello" },
    ]);
    expect(turn.consume(partial(" world")).events).toEqual([
      { type: "text.delta", messageId: "assistant-1", delta: " world" },
    ]);
    expect(turn.consume(assistant("hello world!"))).toEqual({
      events: [
        { type: "text.delta", messageId: "assistant-1", delta: "!" },
        { type: "message.completed", messageId: "assistant-1" },
      ],
    });
    expect(turn.consume(result()).terminal).toEqual({ status: "succeeded" });
  });

  it("uses a complete Assistant message when partial streaming is absent", () => {
    const turn = new ClaudeNativeTurnAccumulator();

    expect(turn.consume(assistant("complete text"))).toEqual({
      events: [
        { type: "text.delta", messageId: "assistant-1", delta: "complete text" },
        { type: "message.completed", messageId: "assistant-1" },
      ],
    });
    expect(turn.consume(result()).terminal).toEqual({ status: "succeeded" });
  });

  it("reconciles separate Assistant text responses across a Tool loop", () => {
    const turn = new ClaudeNativeTurnAccumulator();

    expect(turn.consume(partial("before"))).toEqual({
      events: [{ type: "text.delta", messageId: "assistant-1", delta: "before" }],
    });
    expect(turn.consume(assistant("before tool\n"))).toEqual({
      events: [
        { type: "text.delta", messageId: "assistant-1", delta: " tool\n" },
        { type: "message.completed", messageId: "assistant-1" },
      ],
    });
    expect(turn.consume(toolUse("Edit"))).toEqual({
      events: [
        {
          type: "tool.started",
          callId: "synthetic-tool",
          toolName: "Edit",
          arguments: {},
        },
        { type: "message.completed", messageId: "assistant-synthetic-tool" },
      ],
    });
    expect(
      turn.consume(toolResult("synthetic-tool", { content: "denied", isError: true })),
    ).toEqual({
      events: [
        {
          type: "tool.completed",
          callId: "synthetic-tool",
          toolName: "Edit",
          outputText: "denied",
          isError: true,
        },
      ],
    });
    expect(turn.consume(partial("after", "assistant-2"))).toEqual({
      events: [{ type: "text.delta", messageId: "assistant-2", delta: "after" }],
    });
    expect(turn.consume(assistant("after denial", undefined, "assistant-2"))).toEqual({
      events: [
        { type: "text.delta", messageId: "assistant-2", delta: " denial" },
        { type: "message.completed", messageId: "assistant-2" },
      ],
    });
    expect(turn.consume(result()).terminal).toEqual({ status: "succeeded" });
  });

  it("correlates interleaved Tool results and preserves native file evidence", () => {
    const turn = new ClaudeNativeTurnAccumulator();

    expect(
      turn.consume(
        toolUses(
          { id: "read-1", name: "Read", input: { file_path: "sample.txt" } },
          { id: "edit-1", name: "Edit", input: { file_path: "sample.txt" } },
        ),
      ).events,
    ).toEqual([
      {
        type: "tool.started",
        callId: "read-1",
        toolName: "Read",
        arguments: { file_path: "sample.txt" },
      },
      {
        type: "tool.started",
        callId: "edit-1",
        toolName: "Edit",
        arguments: { file_path: "sample.txt" },
      },
      { type: "message.completed", messageId: "assistant-tools" },
    ]);
    expect(
      turn.consume(
        toolResult("edit-1", {
          content: [{ type: "text", text: "edited" }],
          nativeResult: {
            filePath: "/workspace/sample.txt",
            structuredPatch: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: ["-old", "+new"],
              },
            ],
          },
        }),
      ).events,
    ).toEqual([
      {
        type: "tool.completed",
        callId: "edit-1",
        toolName: "Edit",
        outputText: "edited",
        isError: false,
        fileChange: {
          path: "/workspace/sample.txt",
          kind: "update",
          hunks: [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: ["-old", "+new"],
            },
          ],
        },
      },
    ]);
    expect(turn.consume(toolResult("read-1", { content: "contents" })).events).toEqual([
      {
        type: "tool.completed",
        callId: "read-1",
        toolName: "Read",
        outputText: "contents",
        isError: false,
      },
    ]);
    expect(turn.consume(result()).terminal).toEqual({ status: "succeeded" });
  });

  it("accepts optional correlated Tool Progress without manufacturing output", () => {
    const turn = new ClaudeNativeTurnAccumulator();

    turn.consume(toolUse("Bash", "bash-1", { command: "sleep 1" }));
    expect(
      turn.consume({
        type: "tool_progress",
        tool_use_id: "bash-1",
        elapsed_time_seconds: 1.25,
      }).events,
    ).toEqual([{ type: "tool.progress", callId: "bash-1", elapsedMs: 1_250 }]);
    expect(
      turn.consume(
        toolResult("bash-1", {
          content: [],
          nativeResult: { stdout: "done\n", stderr: "" },
        }),
      ).events,
    ).toEqual([
      {
        type: "tool.completed",
        callId: "bash-1",
        toolName: "Bash",
        outputText: "done\n",
        isError: false,
      },
    ]);
  });

  it("fails a successful Turn with malformed or unresolved Tool correlation", () => {
    const unresolved = new ClaudeNativeTurnAccumulator();
    unresolved.consume(toolUse("Read", "read-1"));
    expect(unresolved.consume(result()).terminal).toEqual({ status: "failed", kind: "protocol" });

    const unknown = new ClaudeNativeTurnAccumulator();
    unknown.consume(toolResult("missing"));
    expect(unknown.consume(result()).terminal).toEqual({ status: "failed", kind: "protocol" });

    const malformed = new ClaudeNativeTurnAccumulator();
    malformed.consume(toolUse("Read", "read-1", { invalid: undefined }));
    expect(malformed.consume(result()).terminal).toEqual({ status: "failed", kind: "protocol" });
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
      { type: "text.delta", messageId: "assistant-thinking", delta: "answer" },
      { type: "message.completed", messageId: "assistant-thinking" },
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
      { type: "text.delta", messageId: "final-only-thinking", delta: "answer" },
      { type: "message.completed", messageId: "final-only-thinking" },
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
      { type: "message.completed", messageId: "assistant-first" },
    ]);
    expect(
      turn.consume(assistantBlocks([{ type: "thinking", thinking: "second" }], "assistant-second"))
        .events,
    ).toEqual([
      { type: "reasoning.delta", messageId: "assistant-second", delta: "second" },
      { type: "reasoning.completed", messageId: "assistant-second" },
      { type: "message.completed", messageId: "assistant-second" },
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
