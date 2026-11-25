import { describe, expect, it } from "vitest";
import type { HostEvent } from "@codexhost/harness-adapter";
import { hostItemIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";

import { ClaudeWorkflowLifecycle } from "../src/workflow-lifecycle.js";

const turnId = hostTurnIdSchema.parse("turn-1");

function lifecycle() {
  const events: HostEvent[] = [];
  let ordinal = 0;
  const workflows = new ClaudeWorkflowLifecycle({
    newItemId: () => hostItemIdSchema.parse(`workflow-item-${++ordinal}`),
    emit: (event) => events.push(event),
  });
  return { events, workflows };
}

describe("Claude Workflow lifecycle", () => {
  it("opens one delegation per run and replaces its agents as they report", () => {
    const { events, workflows } = lifecycle();
    workflows.start({ type: "workflow.started", callId: "workflow-call" });
    expect(events).toEqual([]);
    expect(workflows.pendingCount).toBe(1);

    expect(
      workflows.update(turnId, {
        type: "workflow.updated",
        callId: "workflow-call",
        taskId: "workflow-task",
        description: "Count lines",
      }),
    ).toEqual([]);
    expect(events).toEqual([
      {
        type: "item.started",
        turnId,
        item: {
          type: "subagentDelegation",
          itemId: "workflow-item-1",
          operation: "spawn",
          prompt: "Count lines",
          subagents: [],
        },
      },
    ]);

    const changed = workflows.update(turnId, {
      type: "workflow.updated",
      callId: "workflow-call",
      agents: [
        { index: 2, label: "count:b.txt", state: "queued" },
        {
          index: 1,
          label: "count:a.txt",
          state: "running",
          agentId: "agent-a",
          phaseTitle: "Count",
          model: "claude-sonnet-5-5",
        },
      ],
    });
    expect(changed).toEqual(["agent-a"]);
    expect(events.at(-1)).toEqual({
      type: "item.updated",
      turnId,
      itemId: "workflow-item-1",
      update: {
        type: "subagents.replace",
        subagents: [
          {
            subagentId: "workflow-call:1",
            nativeSubagentId: "agent-a",
            description: "count:a.txt",
            role: "Count",
            model: "claude-sonnet-5-5",
            background: true,
            status: "running",
          },
          {
            subagentId: "workflow-call:2",
            description: "count:b.txt",
            background: true,
            status: "pending",
          },
        ],
      },
    });

    // A repeated frame changes nothing.
    const emitted = events.length;
    workflows.update(turnId, {
      type: "workflow.updated",
      callId: "workflow-call",
      agents: [{ index: 2, label: "count:b.txt", state: "queued" }],
    });
    expect(events).toHaveLength(emitted);
    expect(workflows.activity("workflow-call")).toEqual(["agent-a"]);
    expect(workflows.activity("unknown-call")).toEqual([]);
  });

  it("keeps a launched run open until its native task settles", () => {
    const { events, workflows } = lifecycle();
    workflows.start({ type: "workflow.started", callId: "workflow-call", name: "review" });

    expect(
      workflows.launched(
        turnId,
        {
          type: "workflow.launched",
          callId: "workflow-call",
          isError: false,
          background: true,
          taskId: "workflow-task",
        },
        false,
      ),
    ).toEqual({ callId: "workflow-call", taskId: "workflow-task" });
    expect(events).toMatchObject([
      { type: "item.started", item: { prompt: "review", subagents: [] } },
    ]);
    expect(workflows.pendingCount).toBe(0);
    expect(workflows.taskIds()).toEqual(["workflow-task"]);

    workflows.update(turnId, {
      type: "workflow.updated",
      callId: "workflow-call",
      agents: [
        { index: 1, label: "a", state: "done", agentId: "agent-a", resultPreview: "3 lines" },
        { index: 2, label: "b", state: "running", agentId: "agent-b" },
        { index: 3, label: "c", state: "queued" },
        { index: 4, label: "d", state: "error", agentId: "agent-d", error: "blocked" },
      ],
    });
    expect(
      workflows.settle(turnId, {
        type: "subagent.settled",
        nativeSubagentId: "workflow-task",
        status: "completed",
      }),
    ).toEqual({
      callId: "workflow-call",
      taskId: "workflow-task",
      nativeSubagentIds: ["agent-a", "agent-b", "agent-d"],
    });
    expect(events.at(-1)).toMatchObject({
      type: "item.completed",
      snapshot: {
        outcome: { status: "succeeded" },
        item: {
          subagents: [
            { subagentId: "workflow-call:1", status: "completed", resultSummary: "3 lines" },
            { subagentId: "workflow-call:2", status: "completed" },
            { subagentId: "workflow-call:3", status: "interrupted" },
            { subagentId: "workflow-call:4", status: "failed", resultSummary: "blocked" },
          ],
        },
      },
    });
    expect(workflows.taskIds()).toEqual([]);
    expect(
      workflows.settle(turnId, {
        type: "subagent.settled",
        nativeSubagentId: "workflow-task",
        status: "completed",
      }),
    ).toBeNull();
  });

  it("settles a run that did not launch from its tool result", () => {
    const { events, workflows } = lifecycle();
    workflows.start({ type: "workflow.started", callId: "denied" });
    expect(
      workflows.launched(
        turnId,
        { type: "workflow.launched", callId: "denied", isError: true, background: false },
        false,
      ),
    ).toBeNull();
    expect(events.map(({ type }) => type)).toEqual(["item.started", "item.completed"]);
    expect(events.at(-1)).toMatchObject({
      snapshot: { outcome: { status: "failed", error: { code: "nativeFailure" } } },
    });

    workflows.start({ type: "workflow.started", callId: "cancelled" });
    workflows.launched(
      turnId,
      { type: "workflow.launched", callId: "cancelled", isError: false, background: true },
      true,
    );
    expect(events.at(-1)).toMatchObject({
      snapshot: { outcome: { status: "cancelled" } },
    });
  });

  it("ends open runs with the Turn and drops runs that never reached Claude Code", () => {
    const { events, workflows } = lifecycle();
    workflows.start({ type: "workflow.started", callId: "never-ran" });
    workflows.start({ type: "workflow.started", callId: "running" });
    workflows.update(turnId, {
      type: "workflow.updated",
      callId: "running",
      taskId: "running-task",
      agents: [{ index: 1, label: "a", state: "running", agentId: "agent-a" }],
    });

    workflows.finalize(turnId, { status: "cancelled", reason: "Cancelled by user" });

    expect(events.map(({ type }) => type)).toEqual(["item.started", "item.completed"]);
    expect(events.at(-1)).toMatchObject({
      snapshot: {
        outcome: { status: "cancelled" },
        item: { subagents: [{ nativeSubagentId: "agent-a", status: "interrupted" }] },
      },
    });
    expect(workflows.pendingCount).toBe(0);
  });
});
