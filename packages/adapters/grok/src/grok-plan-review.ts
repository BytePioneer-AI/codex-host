import type { HostQuestionInteraction, HostQuestionResponse } from "@codexhost/harness-adapter";

export const GROK_PLAN_DECISION_ID = "plan-decision";

export interface GrokPlanApprovalRequest {
  sessionId?: string;
  plan: string | null;
  planFilePath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const field = value[key];
    if (typeof field === "string" && field.length > 0) return field;
  }
  return undefined;
}

export function parseGrokExitPlanModeParams(params: unknown): GrokPlanApprovalRequest | null {
  if (!isRecord(params)) return null;
  const nested = isRecord(params.input) ? params.input : params;
  const plan =
    stringField(nested, "planContent", "plan_content", "plan") ??
    stringField(params, "planContent", "plan_content", "plan") ??
    null;
  const planFilePath =
    stringField(nested, "planFilePath", "plan_file_path") ??
    stringField(params, "planFilePath", "plan_file_path");
  const sessionId = stringField(params, "sessionId", "session_id");
  return {
    plan,
    ...(sessionId ? { sessionId } : {}),
    ...(planFilePath ? { planFilePath } : {}),
  };
}

export function createGrokPlanReview(
  request: GrokPlanApprovalRequest,
  interactionId: HostQuestionInteraction["interactionId"],
  turnId: HostQuestionInteraction["turnId"],
): HostQuestionInteraction {
  const warning =
    "Approving this plan will exit Grok plan mode and let Grok begin implementation. " +
    "This is not a one-time tool approval.";
  return {
    type: "question",
    interactionId,
    turnId,
    title: "Review plan",
    questions: [
      {
        id: GROK_PLAN_DECISION_ID,
        type: "choice",
        prompt: request.plan
          ? `${warning}\n\n${request.plan}`
          : "Grok did not provide plan text. Stay in plan mode and ask Grok to present the plan before approving it.",
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
                  description: "Leave plan mode and begin implementation.",
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

export function grokPlanRejectedResponse(): Record<string, unknown> {
  return { approved: false, feedback: "" };
}

export function grokExitPlanModeResponse(
  request: GrokPlanApprovalRequest,
  response: HostQuestionResponse,
): Record<string, unknown> {
  return {
    approved:
      !response.cancelled &&
      request.plan !== null &&
      response.answers[GROK_PLAN_DECISION_ID]?.[0] === "approve",
    feedback: "",
  };
}
