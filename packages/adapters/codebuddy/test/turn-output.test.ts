import { describe, expect, it } from "vitest";
import type { HostEvent, TurnOutcome } from "@codexhost/harness-adapter";
import { CodexTurnProjector } from "@codexhost/protocol-core";
import { hostItemIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import { CodeBuddyTurnOutput } from "../src/projection.js";

function fixture() {
  const turnId = hostTurnIdSchema.parse("streaming-boundaries");
  const events: HostEvent[] = [];
  const projector = new CodexTurnProjector({
    threadId: "thread",
    turnId,
    cwd: "/work",
    startedAtMs: 1_000,
  });
  projector.project({ type: "turn.started", turnId });
  const output = new CodeBuddyTurnOutput(turnId, "/work", (event) => {
    events.push(event);
    if ("turnId" in event && event.type !== "turn.autonomous.started") projector.project(event);
  });
  return {
    output,
    events,
    finish(outcome: TurnOutcome = { status: "succeeded" }) {
      output.finish(outcome.status, outcome.status === "failed" ? outcome.error : undefined);
      return projector.project({ type: "turn.completed", turnId, outcome }).completedTurn;
    },
  };
}

function chunk(type: "text" | "thought", body: string, identity: Record<string, unknown> = {}) {
  return {
    sessionUpdate: type === "text" ? "agent_message_chunk" : "agent_thought_chunk",
    content: { type: "text", text: body },
    ...identity,
  };
}

const tool = {
  sessionUpdate: "tool_call",
  toolCallId: "call",
  title: "Read",
  status: "in_progress",
  rawInput: { file_path: "README.md" },
  _meta: { "codebuddy.ai/toolName": "Read", "codebuddy.ai/toolArgumentsComplete": true },
};
const toolEnd = {
  sessionUpdate: "tool_call_update",
  toolCallId: "call",
  status: "completed",
  rawOutput: { type: "text", text: "file contents" },
};
const llm = (id: string) => ({
  messageId: "session-prompt",
  _meta: { "codebuddy.ai/messageId": "session-prompt", "codebuddy.ai/llmMessageId": id },
});

function completedText(events: HostEvent[]) {
  return events.flatMap((event) =>
    event.type === "item.completed" &&
    (event.snapshot.item.type === "agentMessage" || event.snapshot.item.type === "reasoning")
      ? [event.snapshot]
      : [],
  );
}

describe("CodeBuddy / WorkBuddy streamed message boundaries", () => {
  it("uses per-LLM identity rather than the shared Prompt ID and completes the previous message", () => {
    const { output, events, finish } = fixture();
    output.update(chunk("thought", "first analysis", llm("llm-1")));
    output.update(chunk("text", "Checking.", llm("llm-1")));
    output.update(chunk("thought", "second analysis", llm("llm-2")));
    expect(completedText(events)).toMatchObject([
      { item: { type: "reasoning", text: "first analysis" } },
      { item: { type: "agentMessage", text: "Checking." } },
    ]);
    output.update(chunk("text", "Final ", llm("llm-2")));
    output.update(chunk("text", "answer.", llm("llm-2")));
    expect(finish()).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ type: "agentMessage", text: "Checking.", phase: null }),
        expect.objectContaining({
          type: "agentMessage",
          text: "Final answer.",
          phase: "final_answer",
        }),
      ]),
    });
    expect(completedText(events)).toHaveLength(4);
  });

  it.each([
    ["LLM", llm("same-llm")],
    ["top-level", { messageId: "same-message" }],
    ["metadata", { _meta: { "codebuddy.ai/messageId": "same-message" } }],
    ["absent", {}],
  ])(
    "separates text across Tools even when %s identity is reused or unavailable",
    (_name, identity) => {
      const { output, events, finish } = fixture();
      output.update(chunk("thought", "analysis before tool", identity));
      output.update(chunk("text", "Checking.", identity));
      output.update(tool);
      expect(completedText(events)).toMatchObject([
        { item: { type: "reasoning", text: "analysis before tool" } },
        { item: { type: "agentMessage", text: "Checking." } },
      ]);
      output.update(toolEnd);
      output.update(chunk("thought", "analysis after tool", identity));
      output.update(chunk("text", "Final answer.", identity));
      expect(finish()).toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({ type: "agentMessage", text: "Checking.", phase: null }),
          expect.objectContaining({
            type: "agentMessage",
            text: "Final answer.",
            phase: "final_answer",
          }),
        ]),
      });
      const starts = events.flatMap((event) =>
        event.type === "item.started" ? [event.item.itemId] : [],
      );
      expect(new Set(starts).size).toBe(starts.length);
      expect(completedText(events)).toHaveLength(4);
    },
  );

  it.each([
    ["top-level", (id: string) => ({ messageId: id })],
    ["metadata", (id: string) => ({ _meta: { "codebuddy.ai/messageId": id } })],
  ])("falls back to distinct %s identities on older native runtimes", (_name, identity) => {
    const { output, events, finish } = fixture();
    output.update(chunk("text", "Before.", identity("before")));
    output.update(chunk("text", "After.", identity("after")));
    expect(completedText(events)).toMatchObject([{ item: { text: "Before." } }]);
    expect(finish()).toMatchObject({
      items: [
        expect.objectContaining({ text: "Before.", phase: null }),
        expect.objectContaining({ text: "After.", phase: "final_answer" }),
      ],
    });
  });

  it("does not split parent text on Team output, partial arguments, repeated starts or late tool results", () => {
    const { output, events, finish } = fixture();
    output.update(chunk("text", "Before.", llm("before")));
    output.update({ ...tool, _meta: { "codebuddy.ai/toolName": "Read" } });
    expect(completedText(events)).toEqual([]);
    output.update(tool);
    output.update(chunk("text", "Final ", llm("after")));
    output.update(
      chunk("text", "child", {
        _meta: { "codebuddy.ai/memberEvent": "worker", "codebuddy.ai/llmMessageId": "child" },
      }),
    );
    output.update(tool);
    output.update(toolEnd);
    output.update(toolEnd);
    output.update(chunk("text", "answer.", llm("after")));
    expect(completedText(events)).toHaveLength(1);
    expect(finish()).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ text: "Final answer.", phase: "final_answer" }),
      ]),
    });
    expect(JSON.stringify(events)).not.toContain('"text":"child"');
    expect(completedText(events)).toHaveLength(2);
  });

  it("closes text at native compaction without exposing its internal summary", () => {
    const { output, events, finish } = fixture();
    output.update(chunk("text", "Before compact.", llm("same-model")));
    output.update(
      chunk("text", "hidden summary", {
        ...llm("same-model"),
        _meta: { "codebuddy.ai/isCompactInternal": true },
      }),
    );
    expect(completedText(events)).toMatchObject([{ item: { text: "Before compact." } }]);
    output.confirmCompaction([
      {
        item: { type: "contextCompaction", itemId: hostItemIdSchema.parse("native-compact") },
        outcome: { status: "succeeded" },
      },
    ]);
    output.update(chunk("text", "After compact.", llm("same-model")));
    expect(finish()).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ text: "After compact.", phase: "final_answer" }),
      ]),
    });
    expect(completedText(events)).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain("hidden summary");
  });

  it.each(["failed", "cancelled"] as const)(
    "retains %s on unfinished text without promoting it to a final answer",
    (status) => {
      const { output, events, finish } = fixture();
      output.update(chunk("text", "Checking.", llm("before")));
      output.update(tool);
      output.update(toolEnd);
      output.update(chunk("thought", "unfinished analysis", llm("after")));
      output.update(chunk("text", "Partial answer.", llm("after")));
      const outcome: TurnOutcome =
        status === "failed"
          ? {
              status,
              error: { code: "nativeFailure", message: "native failure", retryable: false },
            }
          : { status };
      expect(finish(outcome)).toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({ text: "Partial answer.", phase: null }),
        ]),
      });
      expect(completedText(events)).toMatchObject([
        { item: { text: "Checking." }, outcome: { status: "succeeded" } },
        { item: { text: "unfinished analysis" }, outcome: { status } },
        { item: { text: "Partial answer." }, outcome: { status } },
      ]);
    },
  );
});
