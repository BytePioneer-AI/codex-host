import { describe, expect, it } from "vitest";

import { ClaudeNativeTurnAccumulator } from "../src/native-message.js";
import { mapClaudeSnapshot, mapClaudeSubagentSnapshot } from "../src/claude-history.js";

// Synthetic protobuf metadata only: field 2 -> field 1 -> field 8 = narration.
const signature = "Eg0KC0IJbmFycmF0aW9u";
const narration = { type: "thinking", thinking: "Please choose a migration rule.", signature };
const reasoning = { type: "thinking", thinking: "Compare the old defaults.", signature: "unknown" };

let streamOrdinal = 0;
function stream(index: number, thinking: string) {
  return {
    type: "stream_event",
    uuid: `stream-${++streamOrdinal}`,
    event: { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking } },
  };
}

function assistant(content: unknown[], uuid = "reply") {
  return { type: "assistant", uuid, message: { id: "native-reply", role: "assistant", content } };
}

describe("Claude native narration", () => {
  it("waits for the signature and separates two streamed thinking blocks before the tool", () => {
    const turn = new ClaudeNativeTurnAccumulator();
    turn.consume({
      type: "stream_event",
      event: { type: "message_start", message: { id: "native-reply" } },
    });
    expect(turn.consume(stream(0, reasoning.thinking)).events).toEqual([]);
    expect(turn.consume(stream(1, narration.thinking)).events).toEqual([]);
    const wrapper = assistant([
      reasoning,
      narration,
      { type: "tool_use", id: "ask", name: "AskUserQuestion", input: {} },
    ]);
    const events = turn.consume(wrapper).events;
    expect(events.slice(0, 4)).toEqual([
      { type: "reasoning.delta", messageId: "native-reply:thinking:0", delta: reasoning.thinking },
      { type: "reasoning.completed", messageId: "native-reply:thinking:0" },
      {
        type: "narration.completed",
        messageId: "native-reply:thinking:1",
        text: narration.thinking,
      },
      { type: "tool.started", callId: "ask", toolName: "AskUserQuestion", arguments: {} },
    ]);
    expect(turn.consume(wrapper).events.some((e) => e.type === "narration.completed")).toBe(false);
  });

  it("handles native per-block wrappers sharing an API message id", () => {
    const turn = new ClaudeNativeTurnAccumulator();
    turn.consume({
      type: "stream_event",
      event: { type: "message_start", message: { id: "native-reply" } },
    });
    turn.consume(stream(0, reasoning.thinking));
    expect(turn.consume(assistant([reasoning], "reasoning-record")).events[0]).toMatchObject({
      type: "reasoning.delta",
    });
    turn.consume(stream(1, narration.thinking));
    const events = turn.consume(assistant([narration], "narration-record")).events;
    expect(events[0]).toMatchObject({ type: "narration.completed", text: narration.thinking });
    expect(events.some((e) => e.type === "reasoning.delta")).toBe(false);
    turn.consume(stream(2, "Later summary"));
    expect(
      turn.consume(assistant([{ ...reasoning, thinking: "Later summary" }], "later-record"))
        .events[0],
    ).toMatchObject({ type: "reasoning.delta", delta: "Later summary" });
  });

  it("accepts signed complete-only narration without exposing unknown complete-only thinking", () => {
    const turn = new ClaudeNativeTurnAccumulator();
    expect(turn.consume(assistant([reasoning, narration])).events).toEqual([
      {
        type: "narration.completed",
        messageId: "native-reply:thinking:1",
        text: narration.thinking,
      },
      { type: "message.completed", messageId: "native-reply", checkpointId: "reply" },
    ]);
  });

  it("reconciles the complete narration suffix exactly once after streaming", () => {
    const turn = new ClaudeNativeTurnAccumulator();
    turn.consume(stream(0, "Please choose"));
    expect(turn.consume(assistant([narration])).events[0]).toMatchObject({
      type: "narration.completed",
      text: narration.thinking,
    });
  });

  it("preserves unfinished or unrecognized thinking on cancellation", () => {
    const turn = new ClaudeNativeTurnAccumulator();
    turn.consume(stream(0, "Unfinished summary"));
    const result = turn.consume({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      terminal_reason: "aborted_streaming",
    });
    expect(result.events[0]).toMatchObject({
      type: "reasoning.delta",
      delta: "Unfinished summary",
    });
    expect(result.events.some((e) => e.type === "narration.completed")).toBe(false);
    expect(result.events.some((e) => e.type === "reasoning.completed")).toBe(false);
  });

  it("keeps nested narration out of the root output", () => {
    const turn = new ClaudeNativeTurnAccumulator();
    expect(
      turn.consume({ ...assistant([narration]), parent_tool_use_id: "worker" }).events,
    ).toEqual([]);
  });
});

describe("Claude narration history", () => {
  const sessionId = "session";
  const laterReasoning = {
    type: "thinking",
    thinking: "Keep the native block order.",
    signature: "unknown",
  };
  const records = [
    {
      type: "user",
      uuid: "user",
      session_id: sessionId,
      message: { role: "user", content: "Migrate" },
    },
    {
      ...assistant([reasoning, narration, laterReasoning, { type: "text", text: "Final answer" }]),
      session_id: sessionId,
    },
  ];

  it("keeps each thinking block in place with its own identity", () => {
    const snapshot = mapClaudeSnapshot(records, sessionId);
    expect(snapshot.turns[0]?.items.map((x) => x.item)).toEqual([
      {
        type: "reasoning",
        itemId: "claude-item-v2-user-reasoning-1",
        text: reasoning.thinking,
      },
      {
        type: "agentMessage",
        itemId: "claude-item-v2-user-agentMessage-1",
        text: narration.thinking,
        phase: "commentary",
      },
      {
        type: "reasoning",
        itemId: "claude-item-v2-user-reasoning-2",
        text: laterReasoning.thinking,
      },
      {
        type: "agentMessage",
        itemId: "claude-item-v2-user-agentMessage-2",
        text: "Final answer",
      },
    ]);
    expect(mapClaudeSnapshot(records, sessionId)).toEqual(snapshot);
  });

  it("uses the same signed classification for subagent transcripts", () => {
    const snapshot = mapClaudeSubagentSnapshot(records, sessionId, "worker");
    expect(snapshot.turns.flatMap((t) => t.items).map((x) => x.item)).toEqual([
      expect.objectContaining({ type: "reasoning", text: reasoning.thinking }),
      expect.objectContaining({
        type: "agentMessage",
        text: narration.thinking,
        phase: "commentary",
      }),
      expect.objectContaining({ type: "reasoning", text: laterReasoning.thinking }),
      expect.objectContaining({ type: "agentMessage", text: "Final answer" }),
    ]);
  });
});
