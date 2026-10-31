import { describe, expect, it } from "vitest";
import type { HostEvent } from "@codexhost/harness-adapter";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { LiveItems } from "../src/live-items.js";

function setup() {
  const events: HostEvent[] = [];
  return {
    events,
    items: new LiveItems(hostTurnIdSchema.parse("host-turn"), (event) => events.push(event)),
  };
}

describe("TRAE CN cumulative live Item projection", () => {
  it("appends only the new native text suffix and completes each Item once", () => {
    const { events, items } = setup();
    items.acceptPlan({ id: "plan", reasoning_content: "你" });
    items.acceptPlan({ id: "plan", reasoning_content: "你好" });
    const final = {
      id: "plan",
      reasoning_content: "你好",
      timing: { tool_call_finished_at_ms: 20 },
      tool_call_info: { name: "finish", params: { summary: "OK" }, result: { status: "success" } },
    };
    items.acceptPlan(final);
    items.acceptPlan(final);
    items.settle({ status: "succeeded" });
    expect(events.map((event) => event.type)).toEqual([
      "item.started",
      "item.updated",
      "item.completed",
      "item.started",
      "item.completed",
    ]);
    expect(events[1]).toMatchObject({
      turnId: "host-turn",
      itemId: "plan.reasoning_content",
      update: { type: "text.append", text: "好" },
    });
    expect(items.snapshots).toHaveLength(2);
  });

  it("starts a tool only once full admitted arguments arrive and preserves its result", () => {
    const { events, items } = setup();
    items.acceptPlan({ id: "tool", tool_call_info: { name: "Read", params: null } });
    expect(events).toEqual([]);
    const running = {
      id: "tool",
      timing: { tool_call_started_at_ms: 10 },
      tool_call_info: { name: "Read", params: { file_path: "/workspace/file" }, result: {} },
    };
    items.acceptPlan(running);
    items.acceptPlan({
      ...running,
      timing: { ...running.timing, tool_call_finished_at_ms: 30 },
      tool_call_info: {
        ...running.tool_call_info,
        result: { status: "success", data: "native content" },
      },
    });
    expect(events.map((event) => event.type)).toEqual([
      "item.started",
      "item.updated",
      "item.completed",
    ]);
    expect(items.snapshots[0]).toMatchObject({
      item: { toolName: "Read", durationMs: 20, output: { content: [{ text: "native content" }] } },
      outcome: { status: "succeeded" },
    });
  });

  it("settles open Items with a native cancellation without changing already completed tools", () => {
    const { events, items } = setup();
    items.acceptPlan({ id: "reasoning", reasoning_content: "partial" });
    items.acceptPlan({
      id: "tool",
      timing: { tool_call_finished_at_ms: 20 },
      tool_call_info: { name: "Read", params: {}, result: { status: "success" } },
    });
    items.settle({ status: "cancelled" });
    items.settle({ status: "cancelled" });
    expect(events.filter((event) => event.type === "item.completed")).toHaveLength(2);
    expect(items.snapshots.map((entry) => entry.outcome.status)).toEqual([
      "cancelled",
      "succeeded",
    ]);
  });

  it("rejects a rewritten text prefix and changes after native completion", () => {
    const { items } = setup();
    items.acceptPlan({ id: "plan", reasoning_content: "first" });
    expect(() => items.acceptPlan({ id: "plan", reasoning_content: "replacement" })).toThrow(
      "published prefix",
    );
    items.settle({ status: "cancelled" });
    expect(() => items.acceptPlan({ id: "plan", reasoning_content: "first later" })).toThrow(
      "after completion",
    );
  });

  it("does not duplicate transient final text streamed through native thought", () => {
    const { events, items } = setup();
    items.acceptPlan({ id: "plan", thought: "answer" });
    expect(events).toEqual([]);
    items.acceptPlan({
      id: "plan",
      thought: "answer",
      tool_call_info: { name: "finish", params: { summary: "answer" } },
    });
    items.acceptPlan({
      id: "plan",
      thought: "",
      tool_call_info: {
        name: "finish",
        params: { summary: "answer" },
        result: { status: "success" },
      },
    });
    expect(items.snapshots).toEqual([
      {
        item: {
          type: "agentMessage",
          itemId: "plan.answer",
          text: "answer",
          phase: "final_answer",
        },
        outcome: { status: "succeeded" },
      },
    ]);
    expect(events.filter((event) => event.type === "item.started")).toHaveLength(1);
  });
});
