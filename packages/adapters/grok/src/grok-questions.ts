// Adapted from karlorz/codex-host@07d8f010ae2e969007c611e035e49f3310b73a9d
// packages/adapters/grok/src/grok-questions.ts (LGPL-3.0-only).
// Native timer metadata/activity extensions are deliberately not exposed here.
import {
  validateHostQuestionResponse,
  type HarnessOutput,
  type HarnessResult,
  type HostQuestionInteraction,
  type InteractionRespondAccepted,
  type InteractionRespondCommand,
} from "@codexhost/harness-adapter";
import {
  hostInteractionIdSchema,
  type HostInteractionId,
  type HostTurnId,
} from "@codexhost/shared-contracts";

export const GROK_ASK_USER_QUESTION_METHOD = "_x.ai/ask_user_question";

interface GrokQuestionOption {
  label: string;
  description: string;
  preview?: string;
}
export interface GrokQuestionRequest {
  sessionId: string;
  toolCallId: string;
  mode: "default" | "plan";
  questions: Array<{ question: string; options: GrokQuestionOption[]; multiple: boolean }>;
}
export type GrokQuestionResponse =
  | { outcome: "cancelled" }
  | {
      outcome: "accepted";
      answers: Record<string, string[]>;
      annotations?: Record<string, { preview?: string; notes?: string }>;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Wire replies use original question text and option labels, not opaque native IDs. */
export function parseGrokQuestionRequest(value: unknown): GrokQuestionRequest {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.sessionId) ||
    !nonEmptyString(value.toolCallId) ||
    (value.mode !== "default" && value.mode !== "plan") ||
    !Array.isArray(value.questions) ||
    value.questions.length === 0
  )
    throw new Error("Grok question requires sessionId, toolCallId, mode and nonempty questions");
  const seen = new Set<string>();
  const questions = value.questions.map((question) => {
    if (
      !isRecord(question) ||
      !nonEmptyString(question.question) ||
      seen.has(question.question) ||
      !Array.isArray(question.options) ||
      (question.multiSelect != null && typeof question.multiSelect !== "boolean") ||
      (question.multi_select != null && typeof question.multi_select !== "boolean")
    )
      throw new Error("Grok question text must be unique and options/multiSelect must be valid");
    if (
      question.multiSelect != null &&
      question.multi_select != null &&
      question.multiSelect !== question.multi_select
    )
      throw new Error("Grok question contains conflicting multi-select flags");
    seen.add(question.question);
    const labels = new Set<string>();
    const options = question.options.map((option) => {
      if (
        !isRecord(option) ||
        !nonEmptyString(option.label) ||
        labels.has(option.label) ||
        typeof option.description !== "string" ||
        (option.preview != null && typeof option.preview !== "string")
      )
        throw new Error(
          "Grok question options require unique labels and text descriptions/previews",
        );
      labels.add(option.label);
      return {
        label: option.label,
        description: option.description,
        ...(typeof option.preview === "string" ? { preview: option.preview } : {}),
      };
    });
    return {
      question: question.question,
      options,
      multiple: question.multiSelect === true || question.multi_select === true,
    };
  });
  return { sessionId: value.sessionId, toolCallId: value.toolCallId, mode: value.mode, questions };
}

interface PendingQuestion {
  request: GrokQuestionRequest;
  interaction: HostQuestionInteraction;
  resolve(response: GrokQuestionResponse): void;
}

/** One Turn's reverse requests. Native interaction_resolved owns timeout withdrawal. */
export class GrokQuestions {
  readonly #pending = new Map<HostInteractionId, PendingQuestion>();
  readonly #seenToolCalls = new Set<string>();
  #closed = false;

  constructor(
    private readonly turnId: HostTurnId,
    private readonly randomUUID: () => string,
    private readonly emit: (output: HarnessOutput) => void,
  ) {}

  has(interactionId: HostInteractionId): boolean {
    return this.#pending.has(interactionId);
  }

  ask(request: GrokQuestionRequest): Promise<GrokQuestionResponse> {
    if (this.#closed || this.#seenToolCalls.has(request.toolCallId))
      return Promise.resolve({ outcome: "cancelled" });
    this.#seenToolCalls.add(request.toolCallId);
    const interaction: HostQuestionInteraction = {
      type: "question",
      interactionId: hostInteractionIdSchema.parse(this.randomUUID()),
      turnId: this.turnId,
      title: "Grok",
      questions: request.questions.map((question, index) =>
        question.options.length
          ? {
              id: `q${index}`,
              type: "choice",
              prompt: question.question,
              options: question.options.map(({ label, description, preview }) => ({
                value: label,
                label,
                description: [description, preview].filter(Boolean).join("\n\n"),
              })),
              multiple: question.multiple,
              allowOther: true,
              optional: true,
            }
          : {
              id: `q${index}`,
              type: "text",
              prompt: question.question,
              multiline: true,
              secret: false,
              optional: true,
            },
      ),
    };
    return new Promise((resolve) => {
      this.#pending.set(interaction.interactionId, { request, interaction, resolve });
      this.emit({ kind: "interaction", interaction });
    });
  }

  respond(command: InteractionRespondCommand): HarnessResult<InteractionRespondAccepted> {
    const pending = this.#pending.get(command.interactionId);
    if (!pending) return this.#error("invalidState", "Grok Question is not pending");
    if (command.response.type !== "question")
      return this.#error("invalidRequest", "Grok Question requires a Question Response");
    const response = command.response;
    const error = validateHostQuestionResponse(pending.interaction, response);
    if (error) return { ok: false, error };
    if (response.cancelled) {
      this.#settle(pending, { outcome: "cancelled" }, "cancelled");
      return { ok: true, value: { accepted: true } };
    }
    const answers = new Map<string, string[]>();
    const annotations = new Map<string, { preview?: string; notes?: string }>();
    for (const [index, question] of pending.request.questions.entries()) {
      const values = response.answers[`q${index}`];
      if (!values?.length) continue;
      if (
        values.some((answer) => !nonEmptyString(answer)) ||
        new Set(values).size !== values.length
      )
        return this.#error("invalidRequest", "Grok answers must be nonempty and unique");
      const selected = values.map((answer) =>
        question.options.find(({ label }) => label === answer),
      );
      const other = values.filter((_, position) => !selected[position]);
      if (other.length > 1)
        return this.#error("invalidRequest", "Grok question accepts only one Other response");
      answers.set(
        question.question,
        selected.map((option) => option?.label ?? "Other"),
      );
      const previews = selected.flatMap((option) =>
        option?.preview !== undefined ? [option.preview] : [],
      );
      if (previews.length || other.length)
        annotations.set(question.question, {
          ...(previews.length ? { preview: previews.join("\n\n") } : {}),
          ...(other.length ? { notes: other[0] } : {}),
        });
    }
    this.#settle(
      pending,
      {
        outcome: "accepted",
        answers: Object.fromEntries(answers),
        ...(annotations.size ? { annotations: Object.fromEntries(annotations) } : {}),
      },
      "responded",
    );
    return { ok: true, value: { accepted: true } };
  }

  withdraw(toolCallId: string): void {
    // Permission resolution may precede a question for the same tool; do not blacklist it.
    for (const pending of this.#pending.values()) {
      if (pending.request.toolCallId === toolCallId)
        this.#settle(pending, { outcome: "cancelled" }, "cancelled");
    }
  }

  cancel(): void {
    this.#closed = true;
    for (const pending of this.#pending.values())
      this.#settle(pending, { outcome: "cancelled" }, "cancelled");
  }

  #settle(
    pending: PendingQuestion,
    response: GrokQuestionResponse,
    reason: "responded" | "cancelled",
  ): void {
    this.#pending.delete(pending.interaction.interactionId);
    pending.resolve(response);
    this.emit({
      kind: "event",
      event: {
        type: "interaction.closed",
        interactionId: pending.interaction.interactionId,
        turnId: this.turnId,
        reason,
      },
    });
  }

  #error(code: "invalidState" | "invalidRequest", message: string): HarnessResult<never> {
    return { ok: false, error: { code, message, retryable: false } };
  }
}
