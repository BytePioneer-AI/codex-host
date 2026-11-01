import { describe, expect, it } from "vitest";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { HostEvent } from "@codexhost/harness-adapter";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { CursorTurnOutput, cursorSnapshot } from "../src/projection.js";
import { CursorSubagents, cursorTaskHandle, cursorTaskAddress } from "../src/subagents.js";

const update = (value: unknown) => ({ sessionId: "parent", update: value }) as SessionNotification;
describe("Cursor native Task cards", () => {
  it("settles background state before the completed snapshot is captured by history replay", () => {
    const input = { _toolName: "task", description: "Background", prompt: "Read files" };
    const replay = [
      update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "delegate" } }),
      update({
        sessionUpdate: "tool_call",
        toolCallId: "replay-0-0",
        rawInput: input,
        status: "completed",
        rawOutput: { isBackground: true },
      }),
    ];
    const history = cursorSnapshot("parent", [{ id: "native-turn", text: "delegate" }], replay);
    expect(history.turns[0]?.items[0]).toMatchObject({
      item: { type: "subagentDelegation", subagents: [{ status: "interrupted" }] },
      outcome: { status: "succeeded" },
    });
  });
  it("retains native Task identity when Cursor rewrites live call IDs during replay", () => {
    const input = { _toolName: "task", description: "Read files", prompt: "Read A and B" };
    const live = new CursorSubagents(hostTurnIdSchema.parse("host-turn"), () => {});
    live.update(
      update({ sessionUpdate: "tool_call", toolCallId: "tool-original-uuid", rawInput: input }),
    );
    live.update(
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-original-uuid",
        status: "completed",
      }),
    );
    live.finish({ status: "succeeded" });
    const handle = cursorTaskHandle(0, 0, input);
    const before = live.snapshot("parent", handle);
    const history = cursorSnapshot(
      "parent",
      [{ id: "native-user-turn", text: "delegate" }],
      [
        update({
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "delegate" },
        }),
        update({ sessionUpdate: "tool_call", toolCallId: "replay-0-2", rawInput: input }),
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: "replay-0-2",
          status: "completed",
        }),
      ],
    );
    expect(history.turns[0]?.items[0]?.item).toMatchObject({
      type: "subagentDelegation",
      subagents: [{ nativeSubagentId: handle }],
    });
    expect(before.turns[0]?.nativeTurnRef.nativeTurnKey).toBe(handle);
    expect(cursorTaskHandle(1, 0, input)).not.toBe(handle);
    expect(cursorTaskHandle(0, 1, input)).not.toBe(handle);
    expect(cursorTaskHandle(0, 0, { ...input, prompt: "different" })).not.toBe(handle);
    expect(() => live.snapshot("parent", cursorTaskHandle(0, 1, input))).toThrow();
  });
  it("rejects an unconfirmed task extension and never leaves background observation running after parent exit", () => {
    const events: HostEvent[] = [],
      tasks = new CursorSubagents(hostTurnIdSchema.parse("turn"), (e) => events.push(e));
    tasks.update(
      update({
        sessionUpdate: "tool_call",
        toolCallId: "native-task",
        rawInput: { _toolName: "task" },
      }),
    );
    expect(tasks.extension("cursor/task", { toolCallId: "native-task" })).toMatchObject({
      outcome: { outcome: "rejected" },
    });
    expect(events.filter((e) => e.type === "item.completed")).toHaveLength(0);
    tasks.update(
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "native-task",
        status: "completed",
        rawOutput: { isBackground: true },
      }),
    );
    tasks.extension("cursor/task", { toolCallId: "native-task" });
    tasks.finish({ status: "succeeded" });
    expect(events.filter((e) => e.type === "subagent.state.changed").at(-1)).toMatchObject({
      status: "interrupted",
    });
    expect(tasks.snapshot("parent", cursorTaskHandle(0, 0, {})).turns[0]?.outcome.status).toBe(
      "cancelled",
    );
  });
  it("preserves pending/running state then uses the confirmed native model and final status", () => {
    const events: HostEvent[] = [],
      output = new CursorTurnOutput(hostTurnIdSchema.parse("turn"), (e) => events.push(e));
    const start = update({
      sessionUpdate: "tool_call",
      toolCallId: "native-task",
      status: "pending",
      rawInput: {
        _toolName: "task",
        description: "Explore",
        prompt: "read files",
        subagentType: { explore: {} },
      },
    });
    const handle = cursorTaskHandle(0, 0, { description: "Explore", prompt: "read files" });
    output.update(start);
    output.update(start);
    expect(events.filter((e) => e.type === "item.started")).toMatchObject([
      { item: { type: "subagentDelegation", subagents: [{ status: "pending" }] } },
    ]);
    expect(output.subagents.snapshot("parent", handle).turns[0]?.outcome).toMatchObject({
      status: "unknown",
      reason: expect.stringContaining("pending"),
    });
    const running = update({
      sessionUpdate: "tool_call_update",
      toolCallId: "native-task",
      status: "in_progress",
    });
    output.update(running);
    output.update(running);
    expect(events.filter((e) => e.type === "item.updated")).toMatchObject([
      { update: { type: "subagents.replace", subagents: [{ status: "running" }] } },
    ]);
    output.update(
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "native-task",
        status: "completed",
        rawOutput: { durationMs: 200, isBackground: false },
      }),
    );
    expect(events.filter((e) => e.type === "item.completed")).toHaveLength(0);
    expect(
      output.subagents.extension("cursor/task", {
        toolCallId: "native-task",
        model: "confirmed-model",
        agentId: "native-agent",
        durationMs: 200,
      }),
    ).toMatchObject({ outcome: { outcome: "completed" } });
    output.finish({ status: "succeeded" });
    expect(events.filter((e) => e.type === "item.completed")).toMatchObject([
      {
        snapshot: {
          item: {
            type: "subagentDelegation",
            subagents: [{ model: "confirmed-model", status: "completed" }],
          },
        },
      },
    ]);
    const snapshot = output.subagents.snapshot("parent", handle);
    expect(snapshot.turns[0]?.items).toEqual([]); // No invented internal child steps.
    expect(snapshot.turns[0]?.input).toEqual([{ type: "text", text: "read files" }]);
  });
  it.each(["pending", "in_progress"])("keeps cancellation distinct for a %s Task", (status) => {
    const events: HostEvent[] = [],
      tasks = new CursorSubagents(hostTurnIdSchema.parse("turn"), (e) => events.push(e));
    tasks.update(
      update({
        sessionUpdate: "tool_call",
        toolCallId: "native-task",
        status,
        rawInput: { _toolName: "task" },
      }),
    );
    tasks.finish({ status: "cancelled" });
    expect(cursorTaskAddress(cursorTaskHandle(0, 0, {}))).toEqual({ turnIndex: 0, taskIndex: 0 });
    expect(() => cursorTaskAddress("../file")).toThrow();
    expect(events.at(-1)).toMatchObject({
      snapshot: {
        item: { subagents: [{ status: "interrupted" }] },
        outcome: { status: "cancelled" },
      },
    });
  });
});
