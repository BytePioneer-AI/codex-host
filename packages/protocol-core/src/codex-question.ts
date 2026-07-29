import type { HostQuestionInteraction, HostQuestionResponse } from "@codexhost/harness-adapter";
import type { JsonObject } from "@codexhost/shared-contracts";

export interface CodexQuestionRequestProjection {
  request: JsonObject;
  parseResponse(result: unknown): HostQuestionResponse;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseError(message: string): Error {
  return new Error(`Codex Question response is invalid: ${message}`);
}

export function projectCodexQuestionRequest(input: {
  threadId: string;
  interaction: HostQuestionInteraction;
  itemId: string;
  emittedAtMs?: number;
}): CodexQuestionRequestProjection {
  const { interaction } = input;
  if (interaction.questions.length === 0) {
    throw new Error("Host Question Interaction must contain at least one Question");
  }
  const questionIds = new Set<string>();
  const choiceLabels = new Map<string, Map<string, string>>();
  const questions = interaction.questions.map((question) => {
    if (question.id.length === 0 || questionIds.has(question.id)) {
      throw new Error("Host Question IDs must be non-empty and unique");
    }
    questionIds.add(question.id);
    if (question.type === "text") {
      if (question.secret) {
        throw new Error("Current Codex Desktop does not safely render secret Question input");
      }
      return {
        id: question.id,
        header: interaction.title ?? "Question",
        question: question.prompt,
        isOther: false,
        isSecret: question.secret,
        options: null,
      };
    }
    if (question.options.length === 0) {
      throw new Error("Choice Question must contain at least one option");
    }
    const labels = new Map<string, string>();
    for (const option of question.options) {
      if (option.value.length === 0 || option.label.length === 0 || labels.has(option.label)) {
        throw new Error(
          "Choice Question option values and labels must be non-empty and labels unique",
        );
      }
      labels.set(option.label, option.value);
    }
    choiceLabels.set(question.id, labels);
    return {
      id: question.id,
      header: interaction.title ?? "Question",
      question: question.prompt,
      isOther: question.allowOther,
      isSecret: false,
      options: question.options.map(({ label, description }) => ({
        label,
        description: description ?? "",
      })),
    };
  });
  const expiresAtMs = interaction.expiresAt ? Date.parse(interaction.expiresAt) : Number.NaN;
  const autoResolutionMs = Number.isFinite(expiresAtMs)
    ? Math.max(0, expiresAtMs - (input.emittedAtMs ?? Date.now()))
    : null;

  return {
    request: {
      method: "item/tool/requestUserInput",
      params: {
        threadId: input.threadId,
        turnId: interaction.turnId,
        itemId: input.itemId,
        questions,
        autoResolutionMs,
      },
    },
    parseResponse(result) {
      if (!isRecord(result) || !isRecord(result.answers)) {
        throw responseError("missing answers object");
      }
      const rawAnswers = result.answers;
      const answerEntries = Object.entries(rawAnswers);
      if (answerEntries.length === 0) {
        return { type: "question", answers: {}, cancelled: true };
      }
      const answers: Record<string, string[]> = {};
      for (const [questionId, answerValue] of answerEntries) {
        const question = interaction.questions.find(({ id }) => id === questionId);
        if (!question) throw responseError("contains an unknown Question ID");
        if (!isRecord(answerValue) || !Array.isArray(answerValue.answers)) {
          throw responseError("answer entry has no answers array");
        }
        const values = answerValue.answers;
        if (!values.every((value): value is string => typeof value === "string")) {
          throw responseError("answer values must be strings");
        }
        if (question.type === "text") {
          if (values.length > 1) throw responseError("text Question has multiple answers");
          answers[questionId] = [...values];
          continue;
        }
        if (!question.multiple && values.length > 1) {
          throw responseError("single-choice Question has multiple answers");
        }
        const labels = choiceLabels.get(questionId);
        if (!labels) throw responseError("choice label mapping is unavailable");
        answers[questionId] = values.map((value) => {
          const mapped = labels.get(value);
          if (mapped !== undefined) return mapped;
          if (question.allowOther) return value;
          throw responseError("contains an undeclared choice");
        });
      }
      for (const question of interaction.questions) {
        const values = answers[question.id] ?? [];
        if (!question.optional && values.length === 0) {
          throw responseError("omits a required answer");
        }
      }
      return { type: "question", answers };
    },
  };
}
