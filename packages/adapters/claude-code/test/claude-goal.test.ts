import { describe, expect, it } from "vitest";

import {
  classifyClaudeGoalCommandOutput,
  deriveClaudeGoalFromTranscript,
} from "../src/claude-goal.js";
import { parseClaudeGoalSignal } from "../src/native-message.js";

const condition = "a file named done.txt exists";

function record(attachment: Record<string, unknown>, timestamp = "2026-09-08T17:14:17.801Z") {
  return { type: "attachment", uuid: timestamp, timestamp, attachment };
}

describe("parseClaudeGoalSignal", () => {
  it("recognises /goal local command output on synthetic Assistant messages", () => {
    expect(
      parseClaudeGoalSignal({
        type: "assistant",
        message: {
          model: "<synthetic>",
          content: [{ type: "text", text: `Goal set: ${condition}` }],
        },
        parent_tool_use_id: null,
      }),
    ).toEqual({ type: "command", output: `Goal set: ${condition}` });
    expect(
      parseClaudeGoalSignal({
        type: "assistant",
        message: { model: "claude-opus-5", content: [{ type: "text", text: "Goal set: nope" }] },
        parent_tool_use_id: null,
      }),
    ).toBeNull();
  });

  it("recognises unrecoverable-error notices", () => {
    expect(
      parseClaudeGoalSignal({
        type: "system",
        subtype: "informational",
        level: "warning",
        content:
          'Goal cleared after an unrecoverable error (model unavailable): "x". Run /goal again to continue.',
      }),
    ).toMatchObject({ type: "clearedByError" });
    expect(parseClaudeGoalSignal({ type: "system", subtype: "init" })).toBeNull();
  });
});

describe("classifyClaudeGoalCommandOutput", () => {
  it("maps every native acknowledgement", () => {
    expect(classifyClaudeGoalCommandOutput(`Goal set: ${condition}`)).toEqual({
      kind: "set",
      objective: condition,
    });
    expect(classifyClaudeGoalCommandOutput(`Goal cleared: ${condition}`)).toEqual({
      kind: "cleared",
      objective: condition,
    });
    expect(classifyClaudeGoalCommandOutput("No goal set. Usage: `/goal <condition>`")).toEqual({
      kind: "noGoal",
    });
    expect(
      classifyClaudeGoalCommandOutput("Goal condition is limited to 4000 characters (got 4001)"),
    ).toMatchObject({ kind: "error", error: { code: "invalidRequest" } });
    expect(
      classifyClaudeGoalCommandOutput("/goal can't run while hooks are restricted."),
    ).toMatchObject({ kind: "error", error: { code: "unsupported" } });
  });
});

describe("deriveClaudeGoalFromTranscript", () => {
  it("replays set, verdict, achieved, failed, and cleared sentinels", () => {
    const set = record({ type: "goal_status", met: false, sentinel: true, condition });
    expect(deriveClaudeGoalFromTranscript([set])).toEqual({
      goal: {
        objective: condition,
        setAtMs: Date.parse("2026-09-08T17:14:17.801Z"),
      },
    });
    const verdict = record({ type: "goal_status", met: false, condition, reason: "not yet" });
    expect(deriveClaudeGoalFromTranscript([set, verdict])).toEqual({
      goal: {
        objective: condition,
        setAtMs: Date.parse("2026-09-08T17:14:17.801Z"),
      },
    });
    expect(
      deriveClaudeGoalFromTranscript([
        set,
        verdict,
        record({ type: "goal_status", met: true, condition, reason: "done" }),
      ]),
    ).toEqual({ goal: null, outcome: "achieved", reason: "done" });
    expect(
      deriveClaudeGoalFromTranscript([
        set,
        record({ type: "goal_status", met: false, failed: true, condition, reason: "impossible" }),
      ]),
    ).toEqual({ goal: null, outcome: "unachievable", reason: "impossible" });
    expect(
      deriveClaudeGoalFromTranscript([
        set,
        record({ type: "goal_status", met: true, sentinel: true, condition }),
      ]),
    ).toEqual({ goal: null, outcome: "cleared" });
    expect(deriveClaudeGoalFromTranscript([])).toEqual({ goal: null });
  });
});
