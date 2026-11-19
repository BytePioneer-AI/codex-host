import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import { projectKimiPlanApprovalRequest } from "../src/plan-approval.js";

// Kimi Code 2.4.0 ACP approval.ts: plan_review uses plan_* IDs and two reject_once exits.
const request: RequestPermissionRequest = {
  sessionId: "plan-session",
  toolCall: { toolCallId: "1:exit-plan", title: "ExitPlanMode" },
  options: [
    { optionId: "plan_approve", name: "Approve", kind: "allow_once" },
    { optionId: "plan_revise", name: "Revise", kind: "reject_once" },
    { optionId: "plan_reject_and_exit", name: "Reject and Exit", kind: "reject_once" },
  ],
};
const turnId = hostTurnIdSchema.parse("plan-turn");

describe("Kimi plan approval isolation", () => {
  it.each(["Bash", "Write", "AskUserQuestion", "exitplanmode", undefined])(
    "does not intercept other tool titles: %s",
    (title) => {
      expect(
        projectKimiPlanApprovalRequest(turnId, {
          ...request,
          toolCall: {
            toolCallId: request.toolCall.toolCallId,
            ...(title === undefined ? {} : { title }),
          },
        }),
      ).toBeNull();
    },
  );

  it.each(
    (
      [
        [],
        [{ optionId: "approve_once", name: "Approve", kind: "allow_once" }],
        request.options.slice(0, 2),
        request.options.slice(1),
        [...request.options, request.options[0]],
        [...request.options, { optionId: "unknown", name: "Unknown", kind: "allow_once" }],
        request.options.map((option) => ({ ...option, name: "Same label" })),
        request.options.map((option) => ({ ...option, name: " " })),
        request.options.map((option) => ({ ...option, kind: "allow_always" })),
      ] as RequestPermissionRequest["options"][]
    ).map((options) => ({ options })),
  )(
    "retains the existing approval path for unsupported or ambiguous options: %j",
    ({ options }) => {
      expect(projectKimiPlanApprovalRequest(turnId, { ...request, options })).toBeNull();
    },
  );

  it("never selects an undeclared option or treats a dismissal as approval", () => {
    const projected = projectKimiPlanApprovalRequest(turnId, request);
    expect(projected).not.toBeNull();
    for (const response of [
      { action: "cancel" },
      { action: "decline" },
      { action: "accept", content: { planApproval: "unknown" } },
      { action: "accept", content: {} },
    ] as const) {
      expect(projected?.parseResponse(response)).toEqual({ outcome: { outcome: "cancelled" } });
    }
  });
});
