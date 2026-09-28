import type {
  HostQuestion,
  HostQuestionInteraction,
  HostQuestionResponse,
} from "@codexhost/harness-adapter";
import type { JsonObject } from "@codexhost/protocol-core";
import {
  hostInteractionIdSchema,
  hostItemIdSchema,
  hostTurnIdSchema,
} from "@codexhost/shared-contracts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function officialQuestions(value: unknown): HostQuestion[] | null {
  if (!Array.isArray(value)) return null;
  const questions: HostQuestion[] = [];
  const ids = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id || ids.has(entry.id)) {
      return null;
    }
    if (typeof entry.question !== "string") return null;
    ids.add(entry.id);
    const options = Array.isArray(entry.options)
      ? entry.options.flatMap((candidate) =>
          isRecord(candidate) && typeof candidate.label === "string" && candidate.label
            ? [
                {
                  value: candidate.label,
                  label: candidate.label,
                  ...(typeof candidate.description === "string" && candidate.description
                    ? { description: candidate.description }
                    : {}),
                },
              ]
            : [],
        )
      : [];
    if (Array.isArray(entry.options) && options.length !== entry.options.length) return null;
    if (options.length > 0) {
      questions.push({
        id: entry.id,
        type: "choice",
        prompt: entry.question,
        options,
        multiple: true,
        allowOther: entry.isOther === true,
        optional: false,
      });
      continue;
    }
    questions.push({
      id: entry.id,
      type: "text",
      prompt: entry.question,
      multiline: false,
      secret: entry.isSecret === true,
      optional: false,
    });
  }
  return questions;
}

/** Translate the native request at the protocol boundary; keep its reply identity. */
export function parseOfficialQuestion(value: JsonObject): {
  threadId: string;
  interaction: HostQuestionInteraction;
} | null {
  const params = value.params;
  if (
    typeof value.id !== "string" ||
    !isRecord(params) ||
    typeof params.threadId !== "string" ||
    typeof params.turnId !== "string" ||
    typeof params.itemId !== "string" ||
    typeof params.isBlocking !== "boolean"
  )
    return null;
  const questions = officialQuestions(params.questions);
  if (!questions?.length) return null;
  return {
    threadId: params.threadId,
    interaction: {
      type: "question",
      interactionId: hostInteractionIdSchema.parse(value.id),
      turnId: hostTurnIdSchema.parse(params.turnId),
      itemId: hostItemIdSchema.parse(params.itemId),
      questions,
    },
  };
}

/** Decode the native response envelope; semantic constraints belong to the shared validator. */
export function parseOfficialQuestionResponse(result: unknown): HostQuestionResponse {
  if (!isRecord(result) || !isRecord(result.answers))
    throw new Error("Native Question response has no answers object");
  const entries = Object.entries(result.answers).map(([id, entry]): [string, string[]] => {
    if (
      !isRecord(entry) ||
      !Array.isArray(entry.answers) ||
      !entry.answers.every((value) => typeof value === "string")
    ) {
      throw new Error("Native Question response must contain string answer arrays");
    }
    return [id, entry.answers];
  });
  return {
    type: "question",
    answers: Object.fromEntries(entries),
    ...(entries.length === 0 ? { cancelled: true } : {}),
  };
}
