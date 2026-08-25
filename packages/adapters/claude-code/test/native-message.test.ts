import { describe, expect, it } from "vitest";

import { ClaudeNativeTurnAccumulator } from "../src/native-message.js";

function partial(text: string, uuid = "assistant-1", parentToolUseId: string | null = null) {
  return {
    type: "stream_event",
    uuid,
    parent_tool_use_id: parentToolUseId,
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

function assistantBlocks(
  content: unknown[],
  uuid: string,
  error?: string,
  parentToolUseId: string | null = null,
) {
  return {
    type: "assistant",
    uuid,
    parent_tool_use_id: parentToolUseId,
    message: { id: uuid, content },
    ...(error ? { error } : {}),
  };
}

function toolUse(name: string, id = "synthetic-tool", input: unknown = {}) {
  const uuid = `assistant-${id}`;
  return {
    type: "assistant",
    uuid,
    parent_tool_use_id: null,
    message: { id: uuid, content: [{ type: "tool_use", name, id, input }] },
  };
}

function toolUses(...blocks: Array<{ id: string; name: string; input: unknown }>) {
  return {
    type: "assistant",
    uuid: "assistant-tools",
    parent_tool_use_id: null,
    message: {
      id: "assistant-tools",
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
        {
          type: "message.completed",
          messageId: "assistant-1",
          checkpointId: "assistant-1",
        },
      ],
    });
    expect(turn.consume(result()).terminal).toEqual({ status: "succeeded" });
  });

  it("uses a complete Assistant message when partial streaming is absent", () => {
    const turn = new ClaudeNativeTurnAccumulator();

    expect(turn.consume(assistant("complete text"))).toEqual({
      events: [
        { type: "text.delta", messageId: "assistant-1", delta: "complete text" },
        {
          type: "message.completed",
          messageId: "assistant-1",
          checkpointId: "assistant-1",
        },
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
        {
          type: "message.completed",
          messageId: "assistant-1",
          checkpointId: "assistant-1",
        },
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
        {
          type: "message.completed",
          messageId: "assistant-synthetic-tool",
          checkpointId: "assistant-synthetic-tool",
        },
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
        {
          type: "message.completed",
          messageId: "assistant-2",
          checkpointId: "assistant-2",
        },
      ],
    });
    expect(turn.consume(result()).terminal).toEqual({ status: "succeeded" });
  });

  it("isolates nested Subagent streams and Tools from the Root response", () => {
    const turn = new ClaudeNativeTurnAccumulator();

    turn.consume(
      toolUse("Agent", "agent-call", {
        description: "Inspect implementation",
        subagent_type: "Explore",
      }),
    );
    expect(turn.consume(partial("root before", "root-1")).events).toEqual([
      { type: "text.delta", messageId: "root-1", delta: "root before" },
    ]);
    expect(
      turn.consume(
        assistantBlocks(
          [{ type: "text", text: "nested answer" }],
          "nested-1",
          undefined,
          "agent-call",
        ),
      ).events,
    ).toEqual([{ type: "subagent.transcript.changed", callId: "agent-call" }]);
    expect(
      turn.consume({
        type: "assistant",
        uuid: "nested-tools",
        parent_tool_use_id: "agent-call",
        message: {
          id: "nested-tools",
          content: [{ type: "tool_use", id: "nested-read", name: "Read", input: {} }],
        },
      }).events,
    ).toEqual([{ type: "subagent.transcript.changed", callId: "agent-call" }]);
    expect(
      turn.consume({
        ...toolResult("nested-read", { content: "contents" }),
        parent_tool_use_id: "agent-call",
      }).events,
    ).toEqual([{ type: "subagent.transcript.changed", callId: "agent-call" }]);
    expect(turn.consume(assistant("root before and after", undefined, "root-1")).events).toEqual([
      { type: "text.delta", messageId: "root-1", delta: " and after" },
      { type: "message.completed", messageId: "root-1", checkpointId: "root-1" },
    ]);
    expect(turn.consume(toolResult("agent-call", { content: "Agent completed" })).events).toEqual([
      {
        type: "subagent.completed",
        callId: "agent-call",
        isError: false,
        resultSummary: "Agent completed",
      },
    ]);
    expect(turn.consume(result()).terminal).toEqual({ status: "succeeded" });
  });

  it("maps Root Agent delegation without exposing nested Tool events", () => {
    const turn = new ClaudeNativeTurnAccumulator();

    expect(
      turn.consume(
        toolUse("Agent", "agent-1", {
          description: "Inspect implementation",
          subagent_type: "Explore",
          run_in_background: true,
          prompt: "private prompt",
        }),
      ).events,
    ).toEqual([
      {
        type: "subagent.started",
        operation: "spawn",
        callId: "agent-1",
        description: "Inspect implementation",
        role: "Explore",
        background: true,
      },
      {
        type: "message.completed",
        messageId: "assistant-agent-1",
        checkpointId: "assistant-agent-1",
      },
    ]);
    expect(
      turn.consume({
        type: "system",
        subtype: "task_started",
        task_id: "native-agent-1",
        tool_use_id: "agent-1",
        description: "Inspect implementation",
        subagent_type: "Explore",
      }).events,
    ).toEqual([
      {
        type: "subagent.updated",
        callId: "agent-1",
        status: "running",
        description: "Inspect implementation",
        role: "Explore",
        nativeSubagentId: "native-agent-1",
      },
    ]);
    expect(
      turn.consume(
        toolResult("agent-1", {
          content: "Agent launched successfully",
          nativeResult: { agentId: "native-agent-1", status: "completed" },
        }),
      ).events,
    ).toEqual([
      {
        type: "subagent.completed",
        callId: "agent-1",
        isError: false,
        nativeSubagentId: "native-agent-1",
        resultSummary: "Agent launched successfully",
      },
    ]);
    expect(turn.consume(result()).terminal).toEqual({ status: "succeeded" });
  });

  it("keeps an async Agent spawn running when its launch Tool Result returns", () => {
    const turn = new ClaudeNativeTurnAccumulator();

    turn.consume(
      toolUse("Agent", "agent-1", {
        description: "Inspect implementation",
        run_in_background: true,
        prompt: "Inspect files",
      }),
    );
    expect(
      turn.consume(
        toolResult("agent-1", {
          content:
            "Async agent launched successfully.\nagentId: native-agent-1\nThe agent is working in the background.",
          nativeResult: {
            isAsync: true,
            status: "async_launched",
            agentId: "native-agent-1",
          },
        }),
      ).events,
    ).toEqual([
      {
        type: "subagent.completed",
        callId: "agent-1",
        isError: false,
        continuesInBackground: true,
        nativeSubagentId: "native-agent-1",
        resultSummary:
          "Async agent launched successfully.\nagentId: native-agent-1\nThe agent is working in the background.",
      },
    ]);

    const textOnlyTurn = new ClaudeNativeTurnAccumulator();
    textOnlyTurn.consume(
      toolUse("Agent", "agent-text-only", {
        description: "Inspect implementation",
        run_in_background: true,
        prompt: "Inspect files",
      }),
    );
    expect(
      textOnlyTurn.consume(
        toolResult("agent-text-only", {
          content:
            "Async agent launched successfully.\nagentId: native-agent-2\nThe agent is working in the background.",
        }),
      ).events,
    ).toEqual([
      {
        type: "subagent.completed",
        callId: "agent-text-only",
        isError: false,
        continuesInBackground: true,
        nativeSubagentId: "native-agent-2",
        resultSummary:
          "Async agent launched successfully.\nagentId: native-agent-2\nThe agent is working in the background.",
      },
    ]);
  });

  it("maps SendMessage to an existing native Subagent without marking the Agent complete", () => {
    const turn = new ClaudeNativeTurnAccumulator();

    expect(
      turn.consume(
        toolUse("SendMessage", "send-1", {
          to: "native-agent-1",
          summary: "Analyze current directory",
          message: "Analyze files and report back",
        }),
      ).events,
    ).toEqual([
      {
        type: "subagent.started",
        operation: "send",
        callId: "send-1",
        nativeSubagentId: "native-agent-1",
        description: "Analyze current directory",
        background: true,
      },
      {
        type: "message.completed",
        messageId: "assistant-send-1",
        checkpointId: "assistant-send-1",
      },
    ]);
    expect(
      turn.consume(toolResult("send-1", { content: "Message sent successfully" })).events,
    ).toEqual([
      {
        type: "subagent.completed",
        callId: "send-1",
        isError: false,
        resultSummary: "Message sent successfully",
      },
    ]);
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
      {
        type: "message.completed",
        messageId: "assistant-tools",
        checkpointId: "assistant-tools",
      },
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

  it("ignores unusable Tool Progress without invalidating correlated Tool evidence", () => {
    const turn = new ClaudeNativeTurnAccumulator();

    expect(
      turn.consume({
        type: "tool_progress",
        tool_use_id: "unknown",
        elapsed_time_seconds: 1,
      }).events,
    ).toEqual([]);
    turn.consume(toolUse("Bash", "bash-1", { command: "printf done" }));
    expect(
      turn.consume({
        type: "tool_progress",
        tool_use_id: "bash-1",
        elapsed_time_seconds: "invalid",
      }).events,
    ).toEqual([]);
    expect(turn.consume(toolResult("bash-1", { content: "done" })).events).toEqual([
      {
        type: "tool.completed",
        callId: "bash-1",
        toolName: "Bash",
        outputText: "done",
        isError: false,
      },
    ]);
    expect(
      turn.consume({
        type: "tool_progress",
        tool_use_id: "bash-1",
        elapsed_time_seconds: 1.25,
      }).events,
    ).toEqual([]);
    expect(turn.consume(result()).terminal).toEqual({ status: "succeeded" });
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

  it("uses only streamed thinking when the complete wrapper contains more thinking", () => {
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
      { type: "reasoning.completed", messageId: "assistant-thinking" },
      { type: "text.delta", messageId: "assistant-thinking", delta: "answer" },
      {
        type: "message.completed",
        messageId: "assistant-thinking",
        checkpointId: "assistant-complete",
      },
    ]);
    expect(turn.consume(result()).terminal).toEqual({ status: "succeeded" });
  });

  it("ignores final-only and protected thinking forms", () => {
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
      { type: "text.delta", messageId: "final-only-thinking", delta: "answer" },
      {
        type: "message.completed",
        messageId: "final-only-thinking",
        checkpointId: "final-only-thinking",
      },
    ]);
  });

  it("ignores conflicting complete reasoning without failing the Turn", () => {
    const turn = new ClaudeNativeTurnAccumulator();

    turn.consume(thinkingPartial("streamed", "reasoning-conflict"));
    expect(
      turn.consume(
        assistantBlocks(
          [{ type: "thinking", thinking: "different", signature: "ignored" }],
          "reasoning-conflict",
        ),
      ).events,
    ).toEqual([
      { type: "reasoning.completed", messageId: "reasoning-conflict" },
      {
        type: "message.completed",
        messageId: "reasoning-conflict",
        checkpointId: "reasoning-conflict",
      },
    ]);
    expect(turn.consume(result()).terminal).toEqual({ status: "succeeded" });
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

  it("normalizes Compaction status and boundary messages without duplicate terminals", () => {
    const turn = new ClaudeNativeTurnAccumulator();

    expect(
      turn.consume({ type: "system", subtype: "status", status: "compacting" }).events,
    ).toEqual([{ type: "compaction.started" }]);
    expect(turn.consume({ type: "system", subtype: "compact_boundary" }).events).toEqual([
      { type: "compaction.completed", outcome: "succeeded" },
    ]);
    expect(
      turn.consume({
        type: "system",
        subtype: "status",
        status: null,
        compact_result: "success",
      }).events,
    ).toEqual([]);

    expect(
      turn.consume({ type: "system", subtype: "status", status: "compacting" }).events,
    ).toEqual([{ type: "compaction.started" }]);
    expect(
      turn.consume({
        type: "system",
        subtype: "status",
        status: null,
        compact_result: "failed",
        compact_error: "private native detail",
      }).events,
    ).toEqual([{ type: "compaction.completed", outcome: "failed" }]);
    expect(turn.consume(result()).terminal).toEqual({ status: "succeeded" });
  });

  it("synthesizes a complete Compaction lifecycle when only a boundary is available", () => {
    const turn = new ClaudeNativeTurnAccumulator();

    expect(turn.consume({ type: "system", subtype: "compact_boundary" }).events).toEqual([
      { type: "compaction.started" },
      { type: "compaction.completed", outcome: "succeeded" },
    ]);
  });

  it("ignores unknown messages", () => {
    const turn = new ClaudeNativeTurnAccumulator();
    expect(turn.consume({ type: "future_event", native: true })).toEqual({ events: [] });
    expect(turn.consume(result()).terminal).toEqual({ status: "succeeded" });
  });
});
