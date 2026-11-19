import { describe, expect, it, vi } from "vitest";
import type { HostEvent } from "@codexhost/harness-adapter";
import { CodexTurnProjector } from "@codexhost/protocol-core";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { CodeBuddySession } from "../src/session.js";
import { fixture } from "./fixtures.js";

const ordinary = {
  sessionUpdate: "tool_call",
  toolCallId: "call",
  title: "Tool",
  rawInput: { description: "Inspect files", prompt: "Read README" },
  _meta: { "codebuddy.ai/toolArgumentsComplete": true },
};
const agent = {
  ...ordinary,
  sessionUpdate: "tool_call_update",
  _meta: { ...ordinary._meta, "codebuddy.ai/toolName": "Agent", "codebuddy.ai/isSubagent": true },
};
const completed = {
  sessionUpdate: "tool_call_update",
  toolCallId: "call",
  status: "completed",
  rawOutput: { type: "text", text: "Done" },
};

async function projectUpdates(updates: unknown[], command = false) {
  const native = fixture();
  const session = new CodeBuddySession(
    { kind: "create", cwd: process.cwd() },
    {},
    native.clientFactory,
    native.readHistory,
  );
  const events: HostEvent[] = [];
  try {
    await session.initialize();
    const client = native.clients[0];
    if (!client) throw Error("Missing native client");
    vi.spyOn(client, "prompt").mockImplementation(async () => {
      native.history.push({ id: "user", type: "message", role: "user", content: "inspect" });
      for (const update of updates) client.update(update);
      native.history.push(
        {
          id: "call-row",
          parentId: "user",
          type: "function_call",
          callId: "call",
          name: "Agent",
          arguments: ordinary.rawInput,
        },
        {
          id: "result-row",
          parentId: "call-row",
          type: "function_call_result",
          callId: "call",
          status: "completed",
          output: "Done",
        },
      );
      return { stopReason: "end_turn", userMessageId: "user" };
    });
    const turnId = hostTurnIdSchema.parse("turn");
    const projector = new CodexTurnProjector({
      threadId: "thread",
      turnId,
      cwd: process.cwd(),
      startedAtMs: 1,
    });
    expect(
      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: command ? "/review" : "inspect" }],
      }),
    ).toMatchObject({ ok: true });
    for await (const output of session.outputs) {
      if (output.kind !== "event") continue;
      events.push(output.event);
      if ("turnId" in output.event && output.event.type !== "turn.autonomous.started")
        projector.project(output.event);
      if (output.event.type === "turn.completed") break;
    }
    expect(events.at(-1)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    return events;
  } finally {
    await session.close();
  }
}

function toolEvents(events: HostEvent[]) {
  return events.filter((event) =>
    event.type === "item.started"
      ? event.item.itemId === "tool-call"
      : event.type === "item.completed" && event.snapshot.item.itemId === "tool-call",
  );
}

describe("CodeBuddy tool call ownership", () => {
  it.each([false, true])(
    "keeps an ordinary tool when Agent metadata arrives (already completed: %s)",
    async (done) => {
      const events = await projectUpdates([
        ordinary,
        ...(done ? [completed] : []),
        agent,
        completed,
        agent,
        completed,
      ]);
      expect(toolEvents(events)).toMatchObject([
        { type: "item.started", item: { type: "toolExecution" } },
        {
          type: "item.completed",
          snapshot: { item: { type: "toolExecution" }, outcome: { status: "succeeded" } },
        },
      ]);
    },
  );

  it("does not route child results into an ordinary parent Tool with the same call ID", async () => {
    const events = await projectUpdates([
      ordinary,
      {
        ...completed,
        rawOutput: { type: "text", text: "child result" },
        _meta: { "codebuddy.ai/parentToolCallId": "parent" },
      },
      agent,
      completed,
    ]);
    expect(toolEvents(events)).toMatchObject([
      { type: "item.started", item: { type: "toolExecution" } },
      { type: "item.completed", snapshot: { item: { output: { content: [{ text: "Done" }] } } } },
    ]);
  });

  it("keeps an Agent call when later updates omit or change its metadata", async () => {
    const events = await projectUpdates([agent, ordinary, completed, ordinary, completed]);
    expect(toolEvents(events)).toMatchObject([
      { type: "item.started", item: { type: "subagentDelegation" } },
      {
        type: "item.completed",
        snapshot: { item: { type: "subagentDelegation" }, outcome: { status: "succeeded" } },
      },
    ]);
  });

  it("recognizes Agent metadata before ordinary argument fragments have started an Item", async () => {
    const events = await projectUpdates([{ ...ordinary, _meta: {} }, agent, completed]);
    expect(toolEvents(events)).toMatchObject([
      { type: "item.started", item: { type: "subagentDelegation" } },
      { type: "item.completed", snapshot: { item: { type: "subagentDelegation" } } },
    ]);
  });

  it("does not replay a command history Item already started by the Agent ledger", async () => {
    const events = await projectUpdates([agent, completed], true);
    expect(toolEvents(events)).toMatchObject([
      { type: "item.started", item: { type: "subagentDelegation" } },
      { type: "item.completed", snapshot: { item: { type: "subagentDelegation" } } },
    ]);
  });
});
