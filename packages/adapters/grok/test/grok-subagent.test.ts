import { describe, expect, it } from "vitest";

import {
  grokNativeSubagentId,
  grokSubagentBackground,
  grokSubagentDescription,
  grokSubagentEventFromUpdate,
  grokSubagentKill,
  grokSubagentModel,
  grokSubagentOperation,
  grokSubagentWaitIds,
  grokSubagentWaitSettlements,
} from "../src/grok-subagent.js";

describe("Grok Subagent ACP mapping", () => {
  it("detects spawn, send, wait, and kill tools across Grok names", () => {
    expect(grokSubagentOperation("spawn_subagent", null, { description: "Inspect" })).toBe("spawn");
    expect(grokSubagentOperation("task", null, { description: "Inspect" })).toBe("spawn");
    expect(
      grokSubagentOperation(undefined, "Inspect the repo", { variant: "Task", task_id: "child-1" }),
    ).toBe("spawn");
    expect(grokSubagentOperation("send_subagent_message", null, { message: "go" })).toBe("send");
    expect(grokSubagentOperation("get_task_output", null, { task_ids: ["child-1"] })).toBeNull();
    expect(grokSubagentOperation("kill_task", null, { task_id: "child-1" })).toBeNull();
  });

  it("defaults background spawn to true and reads subagent_id from ACP text", () => {
    expect(grokSubagentBackground({ description: "Inspect", prompt: "look around" })).toBe(true);
    expect(grokSubagentBackground({ run_in_background: false })).toBe(false);
    expect(grokSubagentBackground({ background: false })).toBe(false);
    expect(
      grokNativeSubagentId({ variant: "Task", task_id: "task-only" }, [
        {
          type: "content",
          content: {
            type: "text",
            text: "Subagent started in background.\nsubagent_id: session-child\n",
          },
        },
      ]),
    ).toBe("session-child");
    expect(grokSubagentDescription({ description: "Inspect the repo" }, "spawn_subagent")).toBe(
      "Inspect the repo",
    );
    expect(grokSubagentModel({ model: "grok-4.6" })).toBe("grok-4.6");
  });

  it("settles wait and kill only when the child is actually terminal", () => {
    expect(
      grokSubagentWaitIds("get_command_or_subagent_output", null, { task_ids: ["child-1"] }),
    ).toEqual(["child-1"]);
    expect(grokSubagentKill("kill_command_or_subagent")).toBe(true);
    expect(
      grokSubagentWaitSettlements({
        name: "get_task_output",
        rawInput: { task_ids: ["child-1"], timeout_ms: 0 },
        rawOutput: { task_id: "child-1", status: "running" },
      }),
    ).toEqual([]);
    expect(
      grokSubagentWaitSettlements({
        name: "get_task_output",
        rawInput: { task_ids: ["child-1"], timeout_ms: 30_000 },
        rawOutput: { task_id: "child-1", status: "completed", output: "done" },
      }),
    ).toEqual([{ id: "child-1", status: "completed", resultSummary: "done" }]);
    expect(
      grokSubagentWaitSettlements({
        name: "kill_task",
        rawInput: { task_id: "child-1" },
      }),
    ).toEqual([{ id: "child-1", status: "interrupted" }]);
    expect(
      grokSubagentWaitSettlements({
        name: "get_command_or_subagent_output",
        rawInput: {
          task_ids: ["child-1", "child-2", "child-3"],
          timeout_ms: 180_000,
        },
        rawOutput: {
          type: "TaskOutput",
          MultiResult: {
            mode: "wait_all",
            results: [
              { task_id: "child-1", status: "completed", output: "entry points" },
              { task_id: "child-2", status: "completed", output: "no tests" },
              { task_id: "child-3", status: "completed", output: "empty mirror" },
            ],
          },
        },
      }),
    ).toEqual([
      { id: "child-1", status: "completed", resultSummary: "entry points" },
      { id: "child-2", status: "completed", resultSummary: "no tests" },
      { id: "child-3", status: "completed", resultSummary: "empty mirror" },
    ]);
    expect(
      grokSubagentWaitSettlements({
        name: "get_command_or_subagent_output",
        rawInput: { task_ids: ["child-1"], timeout_ms: 30_000 },
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "=== Multi-wait (wait_all) ===\n--- Task child-1 [completed] ---\nInspection done\n",
            },
          },
        ],
      }),
    ).toEqual([{ id: "child-1", status: "completed" }]);
  });

  it("reads Grok subagent_spawned and subagent_finished session updates", () => {
    expect(
      grokSubagentEventFromUpdate({
        sessionUpdate: "subagent_spawned",
        subagent_id: "child-1",
        child_session_id: "child-1",
        subagent_type: "explore",
        description: "Scan repo entry points",
        model: "grok-4.6",
      }),
    ).toEqual({
      type: "subagent.spawned",
      nativeSubagentId: "child-1",
      description: "Scan repo entry points",
      role: "explore",
      model: "grok-4.6",
    });
    expect(
      grokSubagentEventFromUpdate({
        sessionUpdate: "subagent_finished",
        subagent_id: "child-1",
        child_session_id: "child-1",
        status: "completed",
        output: "Inspection complete",
        will_wake: false,
      }),
    ).toEqual({
      type: "subagent.finished",
      nativeSubagentId: "child-1",
      status: "completed",
      resultSummary: "Inspection complete",
    });
  });
});
