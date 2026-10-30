import type { HostQuestionInteraction, HostQuestionResponse } from "@codexhost/harness-adapter";

import type { ClaudeInteractionResponse, ClaudePlanApprovalRequest } from "./transport.js";

const DECISION_ID = "plan-decision";

/**
 * Native tool approvals have fixed "Allow once" buttons in Codex Desktop. A plan
 * exit changes the session permission mode, so use an explicit, closed choice
 * instead. Keep the native permission decision inside the Claude Adapter.
 */
export function createClaudePlanReview(
  request: ClaudePlanApprovalRequest,
  interactionId: HostQuestionInteraction["interactionId"],
  turnId: HostQuestionInteraction["turnId"],
): HostQuestionInteraction {
  const warning =
    "Approving this plan will exit plan mode, restore the permission mode used before planning, " +
    "and let Claude begin implementation under that mode. This is not a one-time tool approval.";
  return {
    type: "question",
    interactionId,
    turnId,
    title: "Review plan",
    questions: [
      {
        id: DECISION_ID,
        type: "choice",
        prompt: request.plan
          ? `${warning}\n\n${request.plan}`
          : "Claude Code did not provide plan text. Stay in plan mode and ask Claude to present the plan before approving it.",
        options: [
          {
            value: "stay",
            label: "Stay in plan mode",
            description: "Do not approve the plan or begin implementation.",
          },
          ...(request.plan
            ? [
                {
                  value: "approve",
                  label: "Approve plan and exit plan mode",
                  description: "Resume the previous permission mode and begin implementation.",
                },
              ]
            : []),
        ],
        multiple: false,
        allowOther: false,
        optional: false,
      },
    ],
  };
}

/** Called only after validating the response against the pending closed choice. */
export function claudePlanReviewResponse(
  request: ClaudePlanApprovalRequest,
  response: HostQuestionResponse,
): ClaudeInteractionResponse {
  return {
    type: "approval",
    requestId: request.requestId,
    decision:
      !response.cancelled && request.plan && response.answers[DECISION_ID]?.[0] === "approve"
        ? "allowOnce"
        : "deny",
  };
}
