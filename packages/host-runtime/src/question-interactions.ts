import { randomUUID } from "node:crypto";
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
  turnId: string;
  harnessId: RoutedHarnessId;
  /** The existing requestUserInput params, without interpreting its Questions. */
  request: JsonObject;
  nativeInteractionId?: string;
  expiresAt?: string;
  respond(reply: JsonObject): Promise<void>;
  retire?(): void;
}

interface PendingQuestion extends QuestionRequest {
  timer?: NodeJS.Timeout;
}

/** One pending request shared by Desktop and delegation; reply semantics stay with its owner. */
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
    const pending: PendingQuestion = { ...request };
    this.#pending.set(request.requestId, pending);
    const deadline = Date.parse(request.expiresAt ?? "");
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
      .map(({ requestId, turnId, expiresAt, request }) => ({
        interactionId: this.#publicId(requestId),
        turnId,
        ...(expiresAt ? { expiresAt } : {}),
        request,
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
    if (input.result === undefined) {
      throw new DelegationControlError("INVALID_ARGUMENT", "Question reply result is required");
    }
    await this.effects.run(request.threadId, () =>
      this.#send(request, { result: input.result }, true),
    );
    return {
      threadId: request.threadId,
      turnId: request.turnId,
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
      await this.effects.run(request.threadId, () => this.#send(request, value, false));
    } catch (error) {
      this.effects.diagnose(error);
    }
    return true;
  }

  async closeWhere(matches: (request: QuestionRequest) => boolean): Promise<void> {
    await Promise.all(
      [...this.#pending.values()].filter(matches).map((request) => this.close(request.requestId)),
    );
  }

  async close(requestId: string | number, notify = true): Promise<void> {
    const request = this.#pending.get(requestId);
    if (!request) return;
    this.#take(request);
    await this.#retire(request, notify);
  }

  #take(request: PendingQuestion): void {
    if (this.#pending.get(request.requestId) !== request) throw this.#notPending();
    this.#pending.delete(request.requestId);
    if (request.timer) clearTimeout(request.timer);
  }

  async #retire(request: PendingQuestion, notify: boolean): Promise<void> {
    request.retire?.();
    if (notify)
      await this.effects.resolved(request.threadId, request.requestId).catch(this.effects.diagnose);
  }

  async #send(request: PendingQuestion, reply: JsonObject, notify: boolean): Promise<void> {
    if (Date.parse(request.expiresAt ?? "") <= Date.now()) {
      await this.#expire(request);
      throw this.#notPending();
    }
    // Claim before calling the existing reply handler; failures cannot invite a duplicate send.
    this.#take(request);
    try {
      await request.respond(reply);
    } finally {
      await this.#retire(request, notify);
    }
  }

  async #expire(request: PendingQuestion): Promise<void> {
    if (this.#pending.get(request.requestId) !== request) return;
    this.#take(request);
    // Keep the existing Desktop expiry order: dismiss first, then cancel at the source.
    await this.effects.resolved(request.threadId, request.requestId).catch(this.effects.diagnose);
    try {
      await this.effects.run(request.threadId, () => request.respond({ result: { answers: {} } }));
    } catch (error) {
      this.effects.diagnose(error);
    } finally {
      request.retire?.();
    }
  }

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
