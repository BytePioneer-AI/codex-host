import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEventLikeEntry } from "@deepseek-ai/dsh-api-session-controller/client";
import type { StreamChunk } from "@deepseek-ai/dsh-llm";
import { LlmAttemptId, ToolCallId } from "@deepseek-ai/dsh-llm/brand";
import { ConversationNodeAssembler } from "@deepseek-ai/dsh-client-ui-conversation/src/client/conversation/assembler.ts";
import { assistantDefinition } from "@deepseek-ai/dsh-client-ui-chat/src/client/conversation-nodes/assistant.ts";
import { unknownFallbackDefinition } from "@deepseek-ai/dsh-client-ui-chat/src/client/conversation-nodes/fallback.ts";
import { chatViewDefinition } from "@deepseek-ai/dsh-client-ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts";
import type { ChatSnapshot } from "@deepseek-ai/dsh-client-ui-chat/src/client/contract/snapshot.ts";

function event(
  seq: number,
  type: string,
  data: unknown,
  surfaceOp?: string,
): SessionEventLikeEntry {
  return {
    type: "event",
    event: { seq, time: 1_700_000_000_000 + seq, type, data, ...(surfaceOp ? { surfaceOp } : {}) },
  } as SessionEventLikeEntry;
}

function assembler() {
  const value = new ConversationNodeAssembler(
    { entries: () => [assistantDefinition], fallbackEntry: () => unknownFallbackDefinition },
    { entries: () => [chatViewDefinition] },
  );
  value.replaceWindow(
    [event(1, "turn/start", { turn: 1 }), event(2, "step/start", { turn: 1, step: 1 })],
    false,
  );
  value.activateTarget("chat");
  return value;
}

function append(value: ConversationNodeAssembler, seq: number, chunk: StreamChunk) {
  value.append({
    type: "transient",
    event: {
      type: "assistant/live-chunk",
      seq,
      time: 1_700_000_000_000 + seq,
      data: { attemptId: LlmAttemptId("visibility-test"), turn: 1, step: 1, chunk },
    },
  });
  value.flush();
}

function node(value: ConversationNodeAssembler) {
  return (value.snapshot("chat") as ChatSnapshot).nodes
    .values()
    .find((entry) => entry.kind === "assistant-step");
}

function settle(value: ConversationNodeAssembler, seq: number, text: string) {
  value.append(
    event(
      seq,
      "assistant/message",
      {
        turn: 1,
        step: 1,
        message: {
          id: "settled",
          role: "assistant",
          content: [{ type: "text", text }],
          source: { kind: "model", provider: "fake", model: "fake" },
        },
      },
      "append",
    ),
  );
  value.flush();
}

afterEach(() => vi.restoreAllMocks());

describe("Assistant streamed visibility", () => {
  it.each(["text", "reasoning"] as const)(
    "keeps %s whitespace and first-visible anchoring through settlement",
    (kind) => {
      const value = assembler();
      const whitespace = "\t\n\v\f\r \u00a0\u1680\u2000\u2028\u2029\u202f\u205f\u3000\ufeff";
      append(value, 3, { type: "block-start", index: 0, blockType: kind });
      append(value, 4, { type: `${kind}-delta`, index: 0, text: whitespace });
      expect(node(value)).toBeUndefined();
      append(value, 5, { type: `${kind}-delta`, index: 0, text: "\u200b" });
      const first = node(value);
      expect(first).toMatchObject({
        anchorSeq: 5,
        visibility: "visible",
        data: { time: 1_700_000_000_005 },
      });
      append(value, 6, { type: `${kind}-delta`, index: 0, text: `${whitespace}answer` });
      expect(node(value)).toMatchObject({
        key: first?.key,
        anchorSeq: 5,
        data: { blocks: [{ kind, text: `${whitespace}\u200b${whitespace}answer` }] },
      });
      settle(value, 7, "final answer");
      expect(node(value)).toMatchObject({
        key: first?.key,
        anchorSeq: 5,
        visibility: "visible",
        data: {
          blocks: [{ kind: "text", text: "final answer" }],
          finalNode: { timing: { firstTokenTime: 1_700_000_000_004 } },
        },
      });
    },
  );

  it("handles sparse indices, block resets and kind changes without stale visibility", () => {
    const value = assembler();
    append(value, 3, { type: "text-delta", index: 0, text: "answer" });
    append(value, 4, { type: "reasoning-delta", index: 2, text: "thinking" });
    append(value, 5, { type: "block-start", index: 0, blockType: "text" });
    expect(node(value)?.visibility).toBe("visible");
    append(value, 6, { type: "text-delta", index: 2, text: " " });
    expect(node(value)?.visibility).toBe("hidden");
    append(value, 7, { type: "block-end", index: 0, block: { type: "text", text: "replacement" } });
    expect(node(value)?.visibility).toBe("visible");
    append(value, 8, { type: "block-end", index: 0, block: { type: "text", text: " " } });
    expect(node(value)?.visibility).toBe("hidden");
    append(value, 9, { type: "block-start", index: 0, blockType: "image" });
    expect(node(value)?.visibility).toBe("visible");
    append(value, 10, {
      type: "tool-call-delta",
      index: 0,
      id: ToolCallId("tool"),
      name: "read",
      argumentsDelta: "",
    });
    expect(node(value)?.visibility).toBe("hidden");
    settle(value, 11, "settled");
    expect(node(value)?.visibility).toBe("visible");
  });

  it("resets visibility and anchors after retry", () => {
    const value = assembler();
    append(value, 3, { type: "text-delta", index: 0, text: "first" });
    const first = node(value);
    value.append(event(4, "llm/retry", { turn: 1, step: 1 }));
    append(value, 5, { type: "reasoning-delta", index: 0, text: "\u00a0 " });
    expect(node(value)?.visibility).toBe("hidden");
    append(value, 6, { type: "reasoning-delta", index: 0, text: "replacement" });
    expect(node(value)).toMatchObject({ key: first?.key, anchorSeq: 6, visibility: "visible" });
    settle(value, 7, " ");
    expect(node(value)?.visibility).toBe("hidden");
  });

  it("does not rescan accumulated visible text during streaming", () => {
    const value = assembler();
    const prefix = "ASSISTANT_VISIBILITY_PERF_";
    const trim = String.prototype.trim;
    let scanned = 0;
    vi.spyOn(String.prototype, "trim").mockImplementation(function (this: string) {
      // Ignore the snapshot builder's bounded title excerpts; count full-block scans.
      if (this.length >= 10_000 && this.startsWith(prefix)) scanned += this.length;
      return trim.call(this);
    });
    const text = prefix + "x".repeat(10_000);
    append(value, 3, { type: "text-delta", index: 0, text });
    for (let index = 0; index < 100; index++)
      append(value, index + 4, { type: "text-delta", index: 0, text: "x" });
    expect(node(value)?.data.blocks).toEqual([{ kind: "text", text: text + "x".repeat(100) }]);
    expect(scanned).toBe(text.length);
  });

  it("preserves the no-op fast path for argument-only tool deltas", () => {
    const update = vi.spyOn(assistantDefinition, "update");
    const value = assembler();
    append(value, 3, {
      type: "tool-call-delta",
      index: 0,
      id: ToolCallId("tool"),
      name: "read",
      argumentsDelta: "{",
    });
    append(value, 4, {
      type: "tool-call-delta",
      index: 0,
      id: ToolCallId("tool"),
      argumentsDelta: "}",
    });
    expect(update.mock.results.at(-1)?.value).toBe(update.mock.calls.at(-1)?.[0].state);
  });
});
