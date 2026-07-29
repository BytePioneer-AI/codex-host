import type {
  HarnessError,
  HostQuestionInteraction,
  HostQuestionResponse,
} from "./text-session.js";

function invalidRequest(message: string): HarnessError {
  return { code: "invalidRequest", message, retryable: false };
}

export function validateHostQuestionResponse(
  interaction: HostQuestionInteraction,
  response: HostQuestionResponse,
): HarnessError | null {
  const questionIds = new Set(interaction.questions.map(({ id }) => id));
  if (response.cancelled) {
    return Object.keys(response.answers).length === 0
      ? null
      : invalidRequest("Cancelled Question Response must not contain answers");
  }
  for (const answerId of Object.keys(response.answers)) {
    if (!questionIds.has(answerId)) {
      return invalidRequest("Question Response contains an unknown Question ID");
    }
  }
  for (const question of interaction.questions) {
    const answers = response.answers[question.id] ?? [];
    if (!question.optional && answers.length === 0) {
      return invalidRequest("Question Response omits a required answer");
    }
    if (question.type === "text") {
      if (answers.length > 1) {
        return invalidRequest("Text Question accepts at most one answer");
      }
      continue;
    }
    if (!question.multiple && answers.length > 1) {
      return invalidRequest("Single-choice Question accepts at most one answer");
    }
    const declared = new Set(question.options.map(({ value }) => value));
    if (!question.allowOther && answers.some((answer) => !declared.has(answer))) {
      return invalidRequest("Question Response contains an undeclared choice");
    }
  }
  return null;
}
