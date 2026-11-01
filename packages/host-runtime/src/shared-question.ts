import {
  validateHostQuestionResponse,
  type HostQuestionInteraction,
  type HostQuestionResponse,
} from "@codexhost/harness-adapter";
import { threadQuestionSchema } from "@codexhost/shared-contracts";

export function usesSharedQuestionCard(interaction: HostQuestionInteraction): boolean {
  return interaction.questions.some((question) => question.type === "choice" && question.multiple);
}

export function sharedQuestion(interaction: HostQuestionInteraction) {
  return threadQuestionSchema.parse(interaction);
}

/** Answers carry Host values, unlike the native Desktop path's option labels. */
export function validateSharedQuestionResponse(
  interaction: HostQuestionInteraction,
  response: HostQuestionResponse,
): void {
  const error = validateHostQuestionResponse(interaction, response);
  if (error) throw new Error(error.message);
  for (const values of Object.values(response.answers)) {
    if (new Set(values).size !== values.length) throw new Error("Duplicate Question answers");
    if (values.some((value) => !value.trim())) throw new Error("Empty Question answer");
  }
}
