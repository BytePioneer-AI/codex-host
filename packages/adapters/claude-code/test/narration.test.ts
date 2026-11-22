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

function signatureDelta(index: number) {
  return {
    type: "stream_event",
    event: { type: "content_block_delta", index, delta: { type: "signature_delta", signature } },
  };
}

function stop(index: number) {
  return { type: "stream_event", event: { type: "content_block_stop", index } };
}

function assistant(content: unknown[], uuid = "reply") {
  return { type: "assistant", uuid, message: { id: "native-reply", role: "assistant", content } };
}

describe("Claude native narration", () => {
  it("streams each thinking delta and publishes narration only at the block stop", () => {
    const turn = new ClaudeNativeTurnAccumulator();
    turn.consume({
      type: "stream_event",
      event: { type: "message_start", message: { id: "native-reply" } },
    });
    expect(turn.consume(stream(0, "Compare ")).events).toEqual([
      { type: "reasoning.delta", messageId: "native-reply:thinking:0", delta: "Compare " },
    ]);
    expect(turn.consume(stream(0, "the old defaults.")).events).toEqual([
      { type: "reasoning.delta", messageId: "native-reply:thinking:0", delta: "the old defaults." },
    ]);
    expect(turn.consume(stop(0)).events).toEqual([
      { type: "reasoning.completed", messageId: "native-reply:thinking:0" },
    ]);
    expect(turn.consume(stream(1, narration.thinking)).events).toEqual([
      { type: "reasoning.delta", messageId: "native-reply:thinking:1", delta: narration.thinking },
    ]);
    expect(turn.consume(signatureDelta(1)).events).toEqual([]);
    expect(turn.consume(stop(1)).events).toEqual([
      { type: "reasoning.completed", messageId: "native-reply:thinking:1" },
      {
        type: "narration.completed",
        messageId: "native-reply:thinking:1",
        text: narration.thinking,
      },
    ]);
    expect(turn.consume(stop(1)).events).toEqual([]);
    const wrapper = assistant([
      reasoning,
      narration,
      { type: "tool_use", id: "ask", name: "AskUserQuestion", input: {} },
    ]);
    const events = turn.consume(wrapper).events;
    expect(events[0]).toEqual({
      type: "tool.started",
      callId: "ask",
      toolName: "AskUserQuestion",
      arguments: {},
    });
    expect(
      events.filter((e) => e.type.startsWith("reasoning") || e.type === "narration.completed"),
    ).toEqual([]);
    expect(turn.consume(wrapper).events.some((e) => e.type === "narration.completed")).toBe(false);
  });

  it("handles native per-block wrappers sharing an API message id", () => {
    const turn = new ClaudeNativeTurnAccumulator();
    turn.consume({
      type: "stream_event",
      event: { type: "message_start", message: { id: "native-reply" } },
    });
    turn.consume(stream(0, reasoning.thinking));
    expect(turn.consume(assistant([reasoning], "reasoning-record")).events[0]).toEqual({
      type: "reasoning.completed",
      messageId: "native-reply:thinking:0",
    });
    turn.consume(stream(1, narration.thinking));
    turn.consume(signatureDelta(1));
    expect(turn.consume(stop(1)).events[1]).toMatchObject({ type: "narration.completed" });
    const events = turn.consume(assistant([narration], "narration-record")).events;
    expect(events.some((e) => e.type === "narration.completed")).toBe(false);
    expect(turn.consume(stream(2, "Later summary")).events).toEqual([
      { type: "reasoning.delta", messageId: "native-reply:thinking:2", delta: "Later summary" },
    ]);
    expect(turn.consume(assistant([reasoning], "later-record")).events[0]).toEqual({
      type: "reasoning.completed",
      messageId: "native-reply:thinking:2",
    });
  });

  it("accepts signed complete-only narration without exposing unknown complete-only thinking", () => {
    const turn = new ClaudeNativeTurnAccumulator();
    expect(turn.consume(assistant([reasoning, narration])).events).toEqual([
      {
        type: "narration.completed",
        messageId: "native-reply:thinking:1",
        text: narration.thinking,
        completeOnly: true,
      },
      { type: "message.completed", messageId: "native-reply", checkpointId: "reply" },
    ]);
  });

  it.each([false, true])(
    "reconciles the narration suffix when only the wrapper is signed (stop: %s)",
    (hasStop) => {
      const turn = new ClaudeNativeTurnAccumulator();
      expect(turn.consume(stream(0, "Please choose")).events[0]).toMatchObject({
        type: "reasoning.delta",
        delta: "Please choose",
      });
      if (hasStop) {
        expect(turn.consume(stop(0)).events).toMatchObject([{ type: "reasoning.completed" }]);
      }
      const wrapper = assistant([narration]);
      expect(turn.consume(wrapper).events.slice(0, hasStop ? 1 : 2)).toMatchObject([
        ...(hasStop ? [] : [{ type: "reasoning.completed" }]),
        { type: "narration.completed", text: narration.thinking },
      ]);
      expect(turn.consume(wrapper).events.some((e) => e.type === "narration.completed")).toBe(
        false,
      );
    },
  );

  it("preserves unfinished or unrecognized thinking on cancellation", () => {
    const turn = new ClaudeNativeTurnAccumulator();
    expect(turn.consume(stream(0, "Unfinished summary")).events[0]).toMatchObject({
      type: "reasoning.delta",
      delta: "Unfinished summary",
    });
    turn.requestCancel();
    const result = turn.consume({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      terminal_reason: "aborted_streaming",
    });
    expect(result.terminal).toEqual({ status: "cancelled", reason: "aborted_streaming" });
    expect(result.events).toEqual([]);
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
        itemId: "claude-item-v2-user-reasoning-3",
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
