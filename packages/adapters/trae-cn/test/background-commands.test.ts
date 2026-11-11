import { describe, expect, it } from "vitest";
import type { HostEvent } from "@codexhost/harness-adapter";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { projectPlanItem } from "../src/history.js";
import { LiveItems } from "../src/live-items.js";

// Shapes follow TRAE CN 3.4.13's native background-command registry and wakeup
// handling. These are source-backed cases, not captured inference fixtures.
function command(params: object, result: object, confirm?: object) {
  return {
    id: "command",
    timing: { tool_call_started_at_ms: 1, tool_call_finished_at_ms: 2 },
    tool_call_info: { name: "RunCommand", params: { command: "echo OK", ...params }, result },
    ...(confirm ? { confirm_info: confirm } : {}),
  };
}

describe("TRAE CN background command boundary", () => {
  it.each([
    command({ blocking: false }, { status: "success", data: { command_id: "owned" } }),
    command({}, { status: "success", data: { status: "running_in_background" } }),
    command({}, { status: "success", data: { status: "running" } }),
    command({}, { status: "success", data: { status: "runningskipped" } }),
    command({}, { status: "success", data: { is_background: true } }),
    command({}, { status: "success", data: { run_command_to_bg_reason: "timeout" } }),
    command({}, { status: "success", data: { runCommandToBgReason: "user" } }),
    command({}, { status: "skipped_run" }),
    command({}, { status: "running" }, { confirm_status: "skipped_run" }),
  ])("does not publish a launch/transfer receipt as completed execution", (plan) => {
    const events: HostEvent[] = [];
    const live = new LiveItems(hostTurnIdSchema.parse("host-turn"), (event) => events.push(event));
    expect(() => live.acceptPlan(plan)).toThrowError(
      expect.objectContaining({ code: "unsupported" }),
    );
    expect(events).toEqual([]);
    expect(() => projectPlanItem(plan, { status: "succeeded" })).toThrowError(
      expect.objectContaining({ code: "unsupported" }),
    );
  });

  it("does not turn a running command into success just because the native Turn ended", () => {
    const plan = command({}, { status: "running", data: { command_id: "owned" } });
    expect(projectPlanItem(plan)[0]).not.toHaveProperty("outcome");
    expect(() => projectPlanItem(plan, { status: "succeeded" })).toThrowError(
      expect.objectContaining({ code: "unsupported" }),
    );
  });

  it("retains normal blocking completion and explicit command rejection", () => {
    expect(
      projectPlanItem(
        command({ blocking: true }, { status: "success", data: { exit_code: 0 } }),
      )[0],
    ).toMatchObject({ outcome: { status: "succeeded" } });
    expect(projectPlanItem(command({}, { status: "skipped" }))[0]).toMatchObject({
      outcome: { status: "cancelled" },
    });
  });
});
