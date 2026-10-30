import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { HostEvent, HostItemOutcome } from "@codexhost/harness-adapter";
import { CodexTurnProjector, projectHistoricalTurn } from "@codexhost/protocol-core";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";
import { CursorTurnOutput, cursorSnapshot } from "../src/projection.js";

function fixture() {
  const turnId = hostTurnIdSchema.parse("cursor-answer");
  const events: HostEvent[] = [];
  const projector = new CodexTurnProjector({
    threadId: "thread",
    turnId,
    cwd: "/work",
    startedAtMs: 1_000,
  });
  projector.project({ type: "turn.started", turnId });
  const output = new CursorTurnOutput(turnId, (event) => {
    events.push(structuredClone(event));
    if ("turnId" in event && event.type !== "turn.autonomous.started") projector.project(event);
  });
  return {
    events,
    output,
    send(update: SessionNotification["update"]) {
      output.update({ sessionId: "native", update });
    },
    finish(outcome: HostItemOutcome = { status: "succeeded" }) {
      output.finish(outcome);
      return projector.project({ type: "turn.completed", turnId, outcome }).completedTurn;
    },
  };
}
const text = (body: string): SessionNotification["update"] => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text: body },
});
const tool = (task: boolean): SessionNotification["update"] => ({
  sessionUpdate: "tool_call",
  toolCallId: "call",
  title: task ? "Task" : "Read",
  status: "in_progress",
  rawInput: task
    ? { _toolName: "task", description: "Explore", prompt: "Explore" }
    : { _toolName: "read", path: "README.md" },
});
const completed: SessionNotification["update"] = {
  sessionUpdate: "tool_call_update",
  toolCallId: "call",
  status: "completed",
};

function textCompletions(events: HostEvent[]) {
  return events.flatMap((event) =>
    event.type === "item.completed" && event.snapshot.item.type === "agentMessage"
      ? [event.snapshot]
      : [],
  );
}

describe("Cursor answer boundaries", () => {
  it.each([false, true])(
    "does not split the answer on existing tool updates, starts or terminal replays (Task=%s)",
    (task) => {
      const f = fixture();
      f.send(text("Checking."));
      f.send(tool(task));
      const toolStart = f.events.findIndex(
        (e) =>
          e.type === "item.started" &&
          e.item.type === (task ? "subagentDelegation" : "toolExecution"),
      );
      expect(textCompletions(f.events.slice(0, toolStart))).toMatchObject([
        { item: { text: "Checking." } },
      ]);
      f.send(text("Final "));
      f.send({ sessionUpdate: "tool_call_update", toolCallId: "call", status: "in_progress" });
      f.send(tool(task));
      f.send(text("answer"));
      f.send(completed);
      if (task) f.output.subagents.extension("cursor/task", { toolCallId: "call" });
      f.send(completed);
      f.send(tool(task));
      f.send(text("."));
      expect(textCompletions(f.events)).toHaveLength(1);
      expect(f.finish()).toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({ type: "agentMessage", text: "Checking.", phase: null }),
          expect.objectContaining({
            type: "agentMessage",
            text: "Final answer.",
            phase: "final_answer",
          }),
        ]),
      });
      expect(textCompletions(f.events)).toHaveLength(2);
      const terminals = f.events.filter(
        (e) =>
          e.type === "item.completed" &&
          e.snapshot.item.type === (task ? "subagentDelegation" : "toolExecution"),
      );
      expect(terminals).toHaveLength(1);
    },
  );

  it("ends the prior reply when a genuinely new tool is first observed in an update", () => {
    const f = fixture();
    f.send(text("Before."));
    f.send({
      sessionUpdate: "tool_call_update",
      toolCallId: "new",
      title: "Read",
      status: "completed",
    });
    f.send(text("After."));
    expect(f.finish()).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ text: "Before.", phase: null }),
        expect.objectContaining({ text: "After.", phase: "final_answer" }),
      ]),
    });
  });

  it.each([false, true])(
    "preserves the same full final answer in native history replay (Task=%s)",
    (task) => {
      const updates: SessionNotification["update"][] = [
        { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Question" } },
        text("Checking."),
        tool(task),
        completed,
        text("Final "),
        completed,
        text("answer."),
      ];
      const snapshot = cursorSnapshot(
        "native",
        [{ id: "native-turn", text: "Question" }],
        updates.map((update) => ({ sessionId: "native", update })),
      ).turns[0];
      if (!snapshot) throw new Error("Missing historical turn");
      expect(
        projectHistoricalTurn({
          turnId: hostTurnIdSchema.parse("history"),
          cwd: "/work",
          snapshot,
        }),
      ).toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({ text: "Checking.", phase: null }),
          expect.objectContaining({ text: "Final answer.", phase: "final_answer" }),
        ]),
      });
      expect(snapshot.items.filter(({ item }) => item.type === "agentMessage")).toHaveLength(2);
    },
  );

  it.each([false, true])("does not split reasoning on existing tool updates (Task=%s)", (task) => {
    const f = fixture();
    f.send(tool(task));
    f.send({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking " } });
    f.send(completed);
    f.send(completed);
    f.send({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "more." } });
    f.send(text("Answer."));
    f.finish();
    expect(
      f.events.filter((e) => e.type === "item.completed" && e.snapshot.item.type === "reasoning"),
    ).toMatchObject([{ snapshot: { item: { text: "Thinking more." } } }]);
  });

  it("does not flush a held stream-error prefix on a duplicate tool completion", () => {
    const f = fixture();
    f.send(tool(false));
    f.send(completed);
    f.send(text("Answer.\n\nError: RetriableError: Writable"));
    f.send(completed);
    f.send(text("Iterable is closed"));
    expect(f.finish()).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ text: "Answer.", phase: "final_answer" }),
      ]),
    });
    expect(JSON.stringify(f.events)).not.toContain("Writable");
  });

  it.each(["failed", "cancelled"] as const)(
    "keeps unfinished reply outcome %s after late tool updates",
    (status) => {
      const f = fixture();
      f.send(tool(false));
      f.send(text("Partial "));
      f.send(completed);
      f.send(text("answer."));
      const outcome: HostItemOutcome =
        status === "failed"
          ? { status, error: { code: "nativeFailure", message: "failed", retryable: false } }
          : { status };
      expect(f.finish(outcome)).toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({ text: "Partial answer.", phase: null }),
        ]),
      });
      expect(textCompletions(f.events)).toMatchObject([
        { item: { text: "Partial answer." }, outcome: { status } },
      ]);
    },
  );
});
