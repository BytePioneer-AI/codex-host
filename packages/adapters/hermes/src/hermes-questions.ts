import { randomUUID } from "node:crypto";
import { hostInteractionIdSchema, type HostTurnId } from "@codexhost/shared-contracts";
import {
  validateHostQuestionResponse,
  type HarnessOutput,
  type HarnessResult,
  type HostQuestionInteraction,
  type HostQuestionResponse,
  type InteractionRespondCommand,
  type InteractionRespondAccepted,
} from "@codexhost/harness-adapter";
import type { HermesQuestionRequest } from "./acp-transport.js";

/** Owns native Question validation and exactly-once settlement independently of transport. */
export class HermesQuestions {
  #waiters = new Map<
    string,
    { interaction: HostQuestionInteraction; resolve(response: HostQuestionResponse): void }
  >();
  constructor(readonly emit: (output: HarnessOutput) => void) {}
  open(turnId: HostTurnId, request: HermesQuestionRequest): Promise<HostQuestionResponse> {
    const interactionId = hostInteractionIdSchema.parse(randomUUID());
    const interaction: HostQuestionInteraction = {
      type: "question",
      interactionId,
      turnId,
      questions: request.questions,
      ...(request.title ? { title: request.title } : {}),
    };
    const pending = new Promise<HostQuestionResponse>((resolve) =>
      this.#waiters.set(interactionId, { interaction, resolve }),
    );
    const abort = () =>
      this.#cancel(interactionId, request.signal?.reason === "expired" ? "expired" : "cancelled");
    request.signal?.addEventListener("abort", abort, { once: true });
    this.emit({ kind: "interaction", interaction });
    if (request.signal?.aborted) abort();
    return pending.finally(() => request.signal?.removeEventListener("abort", abort));
  }
  respond(command: InteractionRespondCommand): HarnessResult<InteractionRespondAccepted> {
    const waiter = this.#waiters.get(command.interactionId);
    if (!waiter || command.response.type !== "question")
      return {
        ok: false,
        error: { code: "invalidRequest", message: "No pending Hermes question", retryable: false },
      };
    const error = validateHostQuestionResponse(waiter.interaction, command.response);
    if (error) return { ok: false, error: { ...error, retryable: false } };
    this.#waiters.delete(command.interactionId);
    waiter.resolve(command.response);
    this.emit({
      kind: "event",
      event: {
        type: "interaction.closed",
        interactionId: command.interactionId,
        turnId: waiter.interaction.turnId,
        reason: command.response.cancelled ? "cancelled" : "responded",
      },
    });
    return { ok: true, value: { accepted: true } };
  }
  cancel(turnId?: HostTurnId): void {
    for (const [id, waiter] of this.#waiters)
      if (!turnId || waiter.interaction.turnId === turnId) this.#cancel(id, "cancelled");
  }
  #cancel(id: string, reason: "cancelled" | "expired"): void {
    const waiter = this.#waiters.get(id);
    if (!waiter) return;
    this.#waiters.delete(id);
    waiter.resolve({ type: "question", answers: {}, cancelled: true });
    this.emit({
      kind: "event",
      event: {
        type: "interaction.closed",
        interactionId: waiter.interaction.interactionId,
        turnId: waiter.interaction.turnId,
        reason,
      },
    });
  }
}
