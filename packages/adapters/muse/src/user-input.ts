import type {
  HostQuestion,
  HostQuestionInteraction,
  HostQuestionResponse,
} from "@codexhost/harness-adapter";

import type { JsonObject } from "./msp-client.js";

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mapMuseUserInputQuestions(raw: unknown): HostQuestion[] {
  if (!Array.isArray(raw)) return [];
  const questions: HostQuestion[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry)) continue;
    const id =
      (typeof entry.id === "string" && entry.id.trim()) ||
      (typeof entry.questionId === "string" && entry.questionId.trim()) ||
      `q${index}`;
    const prompt =
      (typeof entry.question === "string" && entry.question.trim()) ||
      (typeof entry.header === "string" && entry.header.trim()) ||
      (typeof entry.prompt === "string" && entry.prompt.trim()) ||
      "Answer";
    const optionsRaw = Array.isArray(entry.options) ? entry.options.filter(isRecord) : [];
    const selection = isRecord(entry.selection) ? entry.selection : {};
    const multiple = selection.mode === "multiple";
    if (optionsRaw.length > 0) {
      questions.push({
        id,
        type: "choice",
        prompt,
        options: optionsRaw.map((option, optionIndex) => {
          const label =
            typeof option.label === "string" && option.label.trim()
              ? option.label.trim()
              : `option-${optionIndex}`;
          return {
            value: label,
            label,
            ...(typeof option.description === "string" && option.description.trim()
              ? { description: option.description.trim() }
              : {}),
          };
        }),
        multiple,
        allowOther: false,
        optional: false,
      });
      continue;
    }
    questions.push({
      id,
      type: "text",
      prompt,
      multiline: false,
      secret: false,
      optional: false,
    });
  }
  return questions;
}

export function museUserInputAnswers(
  interaction: HostQuestionInteraction,
  response: HostQuestionResponse,
): JsonObject[] {
  return interaction.questions.map((entry) => {
    const raw = response.answers[entry.id] ?? [];
    if (entry.type === "choice") {
      return entry.multiple
        ? { questionId: entry.id, selectedLabels: raw }
        : { questionId: entry.id, selectedLabel: raw[0] ?? "" };
    }
    return { questionId: entry.id, freeText: raw[0] ?? "" };
  });
}
