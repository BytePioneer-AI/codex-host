import { randomUUID } from "node:crypto";
import { validateHostQuestionResponse } from "@codexhost/harness-adapter";
import type { HostQuestionInteraction, HostQuestionResponse } from "@codexhost/harness-adapter";
import type { JsonObject, JsonValue, RoutedHarnessId } from "@codexhost/protocol-core";

import { DelegationControlError } from "./delegation-types.js";
import type {
  DelegationPendingQuestion,
  ThreadAnswerInput,
  ThreadAnswerResult,
} from "./delegation-types.js";

interface QuestionRequest {
  requestId: string | number;
  threadId: string;
  harnessId: RoutedHarnessId;
  interaction: HostQuestionInteraction;
  parseResponse(result: unknown): HostQuestionResponse;
  // The native bridge can preserve an explicit Desktop error/cancellation reply.
  respond(response: HostQuestionResponse, desktopReply?: JsonObject): Promise<void>;
  retire?(): void;
}

interface PendingQuestion extends QuestionRequest {
  answering: boolean;
  timer?: NodeJS.Timeout;
}

/** Owns pending Questions and their single settlement, independently of transport. */
export class QuestionInteractions {
  readonly #pending = new Map<string | number, PendingQuestion>();
  readonly #identityPrefix = randomUUID();

  constructor(
    readonly effects: {
      run<T>(threadId: string, operation: () => Promise<T>): Promise<T>;
      resolved(threadId: string, requestId: string | number): Promise<void>;
      diagnose(error: unknown): void;
    },
  ) {}

  register(request: QuestionRequest): void {
    const pending: PendingQuestion = { ...request, answering: false };
    this.#pending.set(request.requestId, pending);
    const deadline = Date.parse(request.interaction.expiresAt ?? "");
    if (Number.isFinite(deadline)) {
      pending.timer = setTimeout(
        () => void this.#expire(pending),
        Math.max(0, deadline - Date.now()),
      );
    }
  }

  read(threadId: string): DelegationPendingQuestion[] {
    return [...this.#pending.values()]
      .filter((request) => request.threadId === threadId)
      .map(({ requestId, interaction: { turnId, title, expiresAt, questions } }) => ({
        interactionId: this.#publicId(requestId),
        turnId,
        ...(title ? { title } : {}),
        ...(expiresAt ? { expiresAt } : {}),
        questions,
      }));
  }

  async answer(input: ThreadAnswerInput): Promise<ThreadAnswerResult> {
    if (typeof input.interactionId !== "string" || !input.interactionId.trim()) {
      throw new DelegationControlError("INVALID_ARGUMENT", "Interaction identifier is required");
    }
    const request = [...this.#pending.values()].find(
      ({ requestId }) => this.#publicId(requestId) === input.interactionId,
    );
    if (!request) throw this.#notPending();
    if (request.threadId !== input.threadId) {
      throw new DelegationControlError("INVALID_ARGUMENT", "Question belongs to another Thread");
    }
    if (
      !input.answers ||
      typeof input.answers !== "object" ||
      Array.isArray(input.answers) ||
      !Object.values(input.answers).every(
        (values) => Array.isArray(values) && values.every((value) => typeof value === "string"),
      )
    ) {
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "Answers must map Question IDs to string arrays",
      );
    }
    await this.effects.run(request.threadId, () =>
      this.#respond(request, { type: "question", answers: input.answers }),
    );
    return {
      threadId: request.threadId,
      turnId: request.interaction.turnId,
      interactionId: this.#publicId(request.requestId),
      harnessId: request.harnessId,
      status: "running",
      next: {
        read: `codexhost thread read ${request.threadId}`,
        wait: `codexhost thread wait ${request.threadId} --timeout-ms 30000`,
      },
    };
  }

  async handleDesktopResponse(value: JsonValue): Promise<boolean> {
    if (!value || typeof value !== "object" || Array.isArray(value) || "method" in value)
      return false;
    if (typeof value.id !== "string" && typeof value.id !== "number") return false;
    const request = this.#pending.get(value.id);
    if (!request) return false;
    try {
      const response: HostQuestionResponse =
        "error" in value
          ? { type: "question", answers: {}, cancelled: true }
          : request.parseResponse(value.result);
      await this.effects.run(request.threadId, () => this.#respond(request, response, value));
    } catch (error) {
      this.effects.diagnose(error);
    }
    return true;
  }

  /** Native closure, Turn/session end, and Runtime shutdown share retirement. */
  async closeWhere(matches: (request: QuestionRequest) => boolean): Promise<void> {
    await Promise.all(
      [...this.#pending.values()].filter(matches).map((request) => this.close(request.requestId)),
    );
  }

  async close(requestId: string | number, notify = true): Promise<void> {
    const request = this.#pending.get(requestId);
    if (!request) return;
    this.#pending.delete(requestId);
    if (request.timer) clearTimeout(request.timer);
    request.retire?.();
    if (notify) {
      await this.effects.resolved(request.threadId, requestId).catch(this.effects.diagnose);
    }
  }

  async #respond(
    request: PendingQuestion,
    response: HostQuestionResponse,
    desktopReply?: JsonObject,
  ): Promise<void> {
    if (this.#pending.get(request.requestId) !== request || request.answering)
      throw this.#notPending();
    if (Date.parse(request.interaction.expiresAt ?? "") <= Date.now()) {
      await this.#expire(request);
      throw this.#notPending();
    }
    const invalid = validateHostQuestionResponse(request.interaction, response);
    if (invalid) throw new DelegationControlError("INVALID_ARGUMENT", invalid.message);
    request.answering = true;
    try {
      await request.respond(response, desktopReply);
    } catch (error) {
      request.answering = false;
      if (error instanceof DelegationControlError && error.code === "QUESTION_NOT_PENDING") {
        await this.close(request.requestId);
      } else if (Date.parse(request.interaction.expiresAt ?? "") <= Date.now()) {
        await this.#expire(request);
      }
      throw error;
    }
    await this.close(request.requestId, desktopReply === undefined);
  }

  async #expire(request: PendingQuestion): Promise<void> {
    if (this.#pending.get(request.requestId) !== request || request.answering) return;
    // Retire before awaiting transport work: no late answer can claim the request.
    await this.close(request.requestId);
    await this.effects
      .run(request.threadId, () =>
        request.respond({ type: "question", answers: {}, cancelled: true }),
      )
      .catch(this.effects.diagnose);
  }

  /** Host wire IDs are unique here; the prefix also separates rebuilt Host instances. */
  #publicId(requestId: string | number): string {
    return `${this.#identityPrefix}:${requestId}`;
  }

  #notPending(): DelegationControlError {
    return new DelegationControlError(
      "QUESTION_NOT_PENDING",
      "Question is no longer pending or is being answered",
    );
  }
}
