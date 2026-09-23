import { hostInteractionIdSchema, type HostTurnId } from "@codexhost/shared-contracts";
import type { HostInteraction, HostQuestionResponse } from "@codexhost/harness-adapter";
import { KimiError, type NativeQuestion, type NativeSnapshot } from "./protocol.js";

export interface PendingInteraction {
  interaction: HostInteraction;
  nativeId: string;
  responding: boolean;
}
export function interactions(snapshot: NativeSnapshot, turnId: HostTurnId): PendingInteraction[] {
  const approvals: PendingInteraction[] = snapshot.pending_approvals
    .filter((request) => request.agent_id === "main")
    .map((request) => ({
      nativeId: request.approval_id,
      responding: false,
      interaction: {
        type: "approval",
        interactionId: hostInteractionIdSchema.parse(`kimi:approval:${request.approval_id}`),
        turnId,
        title: request.tool_name,
        description: request.action,
        subject: { type: "nativeAction" },
        actions: [
          { id: "once", label: "Allow once", effect: "allowOnce" },
          { id: "session", label: "Allow for session", effect: "allowForSession" },
          { id: "deny", label: "Deny", effect: "deny" },
        ],
        expiresAt: request.expires_at,
      },
    }));
  return [
    ...approvals,
    ...snapshot.pending_questions
      .filter((request) => !request.agent_id || request.agent_id === "main")
      .map((request): PendingInteraction => ({
        nativeId: request.question_id,
        responding: false,
        interaction: {
          type: "question",
          interactionId: hostInteractionIdSchema.parse(`kimi:question:${request.question_id}`),
          turnId,
          questions: request.questions.map((question) => ({
            type: "choice",
            id: question.id,
            prompt: [question.question, question.body].filter(Boolean).join("\n\n"),
            options: question.options.map((option) => ({
              value: option.id,
              label: option.label,
              ...(option.description ? { description: option.description } : {}),
            })),
            multiple: question.multi_select ?? false,
            allowOther: question.allow_other ?? true,
            optional: true,
          })),
        },
      })),
  ];
}
export function nativeAnswers(
  questions: NativeQuestion["questions"],
  response: HostQuestionResponse,
): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const question of questions) {
    const values = response.answers[question.id] ?? [];
    const selected = values.filter((value) =>
      question.options.some((option) => option.id === value),
    );
    const other = values.filter((value) => !selected.includes(value));
    if (other.length > 1)
      throw new KimiError(
        "invalidRequest",
        "Kimi Code accepts only one free-text answer per question",
      );
    if (!values.length) answers[question.id] = { kind: "skipped" };
    else if (other.length && selected.length)
      answers[question.id] = {
        kind: "multi_with_other",
        option_ids: selected,
        other_text: other[0],
      };
    else if (other.length) answers[question.id] = { kind: "other", text: other[0] };
    else if (question.multi_select) answers[question.id] = { kind: "multi", option_ids: selected };
    else answers[question.id] = { kind: "single", option_id: selected[0] };
  }
  return answers;
}
