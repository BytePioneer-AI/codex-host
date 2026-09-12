import { describe, expect, it } from "vitest";

import { hostInteractionIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";

import {
  GROK_PLAN_DECISION_ID,
  createGrokPlanReview,
  grokExitPlanModeResponse,
  grokPlanRejectedResponse,
  parseGrokExitPlanModeParams,
} from "../src/grok-plan-review.js";

describe("Grok exit_plan_mode ACP envelope", () => {
  it("parses camelCase and snake_case plan payloads", () => {
    expect(
      parseGrokExitPlanModeParams({
        sessionId: "session",
        planContent: "# Plan\nDo the work.",
        planFilePath: "/tmp/plan.md",
      }),
    ).toEqual({
      sessionId: "session",
      plan: "# Plan\nDo the work.",
      planFilePath: "/tmp/plan.md",
    });
    expect(
      parseGrokExitPlanModeParams({
        session_id: "session",
        plan_content: "# Plan",
        plan_file_path: "/tmp/plan.md",
      }),
    ).toMatchObject({ plan: "# Plan", planFilePath: "/tmp/plan.md" });
  });

  it("treats a missing plan as an empty review that cannot be approved", () => {
    const request = parseGrokExitPlanModeParams({ sessionId: "session" });
    if (!request) throw new Error("Expected a parsed Grok Plan request");
    expect(request.plan).toBeNull();
    const interaction = createGrokPlanReview(
      request,
      hostInteractionIdSchema.parse("plan-1"),
      hostTurnIdSchema.parse("turn-1"),
    );
    expect(interaction.questions[0]).toMatchObject({
      id: GROK_PLAN_DECISION_ID,
      options: [{ value: "stay" }],
    });
    expect(interaction.questions[0]?.prompt).toContain("did not provide plan text");
    expect(
      grokExitPlanModeResponse(request, {
        type: "question",
        answers: { [GROK_PLAN_DECISION_ID]: ["approve"] },
      }),
    ).toEqual(grokPlanRejectedResponse());
  });

  it("maps approve, stay, and cancel to the native plan decision", () => {
    const request = parseGrokExitPlanModeParams({ planContent: "# Implement" });
    if (!request) throw new Error("Expected a parsed Grok Plan request");
    const interaction = createGrokPlanReview(
      request,
      hostInteractionIdSchema.parse("plan-1"),
      hostTurnIdSchema.parse("turn-1"),
    );
    expect(interaction.title).toBe("Review plan");
    expect(interaction.questions[0]?.prompt).toContain("# Implement");
    expect(interaction.questions[0]?.prompt).toContain("exit Grok plan mode");
    expect(
      grokExitPlanModeResponse(request, {
        type: "question",
        answers: { [GROK_PLAN_DECISION_ID]: ["approve"] },
      }),
    ).toEqual({ approved: true, feedback: "" });
    expect(
      grokExitPlanModeResponse(request, {
        type: "question",
        answers: { [GROK_PLAN_DECISION_ID]: ["stay"] },
      }),
    ).toEqual({ approved: false, feedback: "" });
    expect(
      grokExitPlanModeResponse(request, { type: "question", answers: {}, cancelled: true }),
    ).toEqual({ approved: false, feedback: "" });
  });
});
