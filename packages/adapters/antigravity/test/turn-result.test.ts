import { describe, expect, it } from "vitest";

import { hasHistoricalAntigravityError } from "../src/turn-result.js";

const step = (type: string) => ({
  type: `CORTEX_STEP_TYPE_${type}`,
  status: "CORTEX_STEP_STATUS_DONE",
});
// Reconstructed from the reported native conversation: the first Turn had a
// project permission error, followed by a completed reply in the next Turn.
const trajectory = () => ({
  status: "CASCADE_RUN_STATUS_IDLE",
  trajectory: {
    cascadeId: "conversation",
    steps: [step("USER_INPUT"), step("ERROR"), step("USER_INPUT"), step("PLANNER_RESPONSE")],
  },
});
const result = {
  conversation_id: "conversation",
  status: "ERROR",
  response: "Hello! How can I help you today?",
  num_turns: 2,
};

describe("Antigravity historical result errors", () => {
  it("requires a native completed current Turn after a historical error", () => {
    expect(hasHistoricalAntigravityError(trajectory(), result, 3)).toBe(true);
  });

  it.each(["ERROR", "RUNNING", "UNSPECIFIED"])("retains a current %s step", (status) => {
    const value = trajectory();
    value.trajectory.steps[3] = {
      ...step("PLANNER_RESPONSE"),
      status: `CORTEX_STEP_STATUS_${status}`,
    };
    expect(hasHistoricalAntigravityError(value, result, 3)).toBe(false);
  });

  it("retains a current cascade error even when the error step itself is DONE", () => {
    const value = trajectory();
    value.trajectory.steps.splice(3, 0, step("ERROR"));
    expect(hasHistoricalAntigravityError(value, result, 4)).toBe(false);
  });

  it("does not infer success from response text or missing evidence", () => {
    for (const value of [null, {}, { trajectory: {} }]) {
      expect(hasHistoricalAntigravityError(value, result, 3)).toBe(false);
    }
    expect(hasHistoricalAntigravityError(trajectory(), result, null)).toBe(false);
    expect(hasHistoricalAntigravityError(trajectory(), result, 2)).toBe(false);
    expect(hasHistoricalAntigravityError(trajectory(), { ...result, response: "" }, 3)).toBe(false);
    expect(
      hasHistoricalAntigravityError(trajectory(), { ...result, error: "stream lost" }, 3),
    ).toBe(false);
  });

  it("rejects a different session, stale Turn count, or running cascade", () => {
    expect(
      hasHistoricalAntigravityError(trajectory(), { ...result, conversation_id: "other" }, 3),
    ).toBe(false);
    expect(hasHistoricalAntigravityError(trajectory(), { ...result, num_turns: 3 }, 3)).toBe(false);
    expect(
      hasHistoricalAntigravityError(
        { ...trajectory(), status: "CASCADE_RUN_STATUS_RUNNING" },
        result,
        3,
      ),
    ).toBe(false);
  });

  it("requires an old error and a terminal planner response", () => {
    const value = trajectory();
    value.trajectory.steps[1] = step("PLANNER_RESPONSE");
    expect(hasHistoricalAntigravityError(value, result, 3)).toBe(false);
    value.trajectory.steps[1] = step("ERROR");
    value.trajectory.steps[3] = step("CODE_ACTION");
    expect(hasHistoricalAntigravityError(value, result, 3)).toBe(false);
  });

  it("retains native error details in the current Turn", () => {
    const value = trajectory();
    value.trajectory.steps[3] = Object.assign(step("PLANNER_RESPONSE"), {
      errorDetails: { message: "failure" },
    });
    expect(hasHistoricalAntigravityError(value, result, 3)).toBe(false);
  });
});
