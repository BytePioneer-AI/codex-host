import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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
  it("does not admit partial file-edit arguments from the real generating sequence", () => {
    const plans: unknown[] = JSON.parse(
      readFileSync(new URL("./fixtures/native-file-edit.json", import.meta.url), "utf8"),
    );
    const { events, items } = setup();
    for (const plan of plans.slice(0, 6)) items.acceptPlan(plan);
    expect(events).toEqual([]);
    for (const plan of plans.slice(6)) items.acceptPlan(plan);
    expect(events.filter((event) => event.type === "item.started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "item.completed")).toHaveLength(1);
    expect(items.snapshots).toMatchObject([
      {
        item: {
          type: "toolExecution",
          toolName: "Edit",
          arguments: { file_path: "/workspace/file.txt", old_string: "", new_string: "" },
        },
        outcome: { status: "succeeded" },
      },
    ]);
    expect(items.snapshots.some((entry) => entry.item.type === "fileChange")).toBe(false);
  });
  it("waits through the real native sandbox confirmation receipt for the actual command result", () => {
    // TRAE CN 3.4.12 Windows event sequence; identifiers/paths normalized.
    const plans: unknown[] = JSON.parse(
      readFileSync(new URL("./fixtures/native-command-approval.json", import.meta.url), "utf8"),
    );
    const { events, items } = setup();
    for (const plan of plans) items.acceptPlan(plan);
    const completions = events.filter((e) => e.type === "item.completed");
    expect(completions).toHaveLength(1);
    expect(items.snapshots).toMatchObject([
      {
        item: { type: "commandExecution", exitCode: 0, output: "", cwd: "/workspace" },
        outcome: { status: "succeeded" },
      },
    ]);
  });
  it("preserves the native failed command after an explicit sandbox escape denial", () => {
    const plans: unknown[] = JSON.parse(
      readFileSync(new URL("./fixtures/native-command-denial.json", import.meta.url), "utf8"),
    );
    const { events, items } = setup();
    for (const plan of plans) items.acceptPlan(plan);
    expect(events.filter((e) => e.type === "item.completed")).toHaveLength(1);
    expect(items.snapshots).toMatchObject([
      { item: { type: "commandExecution", exitCode: 1 }, outcome: { status: "failed" } },
    ]);
  });
  it("projects command output and tolerates native approval normalization of launch metadata", () => {
    const { events, items } = setup();
    const running = {
      id: "command",
      timing: { tool_call_started_at_ms: 10 },
      tool_call_info: {
        name: "RunCommand",
        params: { command: "echo OK", blocking: true, requires_approval: false },
      },
    };
    items.acceptPlan(running);
    items.acceptPlan({
      ...running,
      confirm_info: { confirm_status: "unconfirmed" },
      tool_call_info: { name: "RunCommand", params: { command: "echo OK", cwd: "/workspace" } },
    });
    items.acceptPlan({
      ...running,
      timing: { ...running.timing, tool_call_finished_at_ms: 30 },
      tool_call_info: {
        ...running.tool_call_info,
        result: { status: "success", data: { stdout: "OK\n", exit_code: 0, cwd: "/workspace" } },
      },
    });
    expect(items.snapshots).toEqual([
      {
        item: {
          type: "commandExecution",
          itemId: "command.tool",
          command: "echo OK",
          cwd: "/workspace",
          output: "OK\n",
          exitCode: 0,
          durationMs: 20,
        },
        outcome: { status: "succeeded" },
      },
    ]);
    expect(events.filter((e) => e.type === "item.updated")).toMatchObject([
      { update: { type: "output.append", text: "OK\n" } },
    ]);
  });
  it("preserves command rejection and nonzero exits instead of reporting a successful execution", () => {
    for (const [result, confirm, expected] of [
      [{ status: "skipped" }, { confirm_status: "skipped" }, "cancelled"],
      [{ status: "success", data: { exit_code: 7, stdout: "error" } }, undefined, "failed"],
    ] as const) {
      const { items } = setup();
      items.acceptPlan({
        id: "command",
        timing: { tool_call_started_at_ms: 1, tool_call_finished_at_ms: 2 },
        tool_call_info: { name: "RunCommand", params: { command: "echo OK" }, result },
        confirm_info: confirm,
      });
      expect(items.snapshots[0]?.outcome.status).toBe(expected);
    }
  });
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

  it("compares native tool argument values independently of JSON object key order", () => {
    const { items } = setup();
    items.acceptPlan({
      id: "tool",
      timing: { tool_call_started_at_ms: 1 },
      tool_call_info: {
        name: "AskUserQuestion",
        params: { questions: [{ options: [{ description: "detail", label: "choice" }] }] },
      },
    });
    expect(() =>
      items.acceptPlan({
        id: "tool",
        timing: { tool_call_started_at_ms: 1 },
        tool_call_info: {
          name: "AskUserQuestion",
          params: { questions: [{ options: [{ label: "choice", description: "detail" }] }] },
        },
      }),
    ).not.toThrow();
    expect(() =>
      items.acceptPlan({
        id: "tool",
        timing: { tool_call_started_at_ms: 1 },
        tool_call_info: {
          name: "AskUserQuestion",
          params: { questions: [{ options: [{ label: "changed", description: "detail" }] }] },
        },
      }),
    ).toThrow("admitted arguments");
  });
});
