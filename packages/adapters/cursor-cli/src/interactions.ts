import { randomUUID } from "node:crypto";
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import {
  validateHostInteractionResponse,
  type HarnessOutput,
  type HarnessResult,
  type HostInteraction,
  type HostInteractionResponse,
  type InteractionRespondCommand,
  type InteractionRespondAccepted,
} from "@codexhost/harness-adapter";
import { hostInteractionIdSchema, type HostTurnId } from "@codexhost/shared-contracts";

export class CursorInteractions {
  readonly #pending = new Map<
    string,
    {
      interaction: HostInteraction;
      resolve: (response: HostInteractionResponse | undefined) => void;
    }
  >();
  constructor(readonly emit: (output: HarnessOutput) => void) {}
  #ask(interaction: HostInteraction): Promise<HostInteractionResponse | undefined> {
    return new Promise((resolve) => {
      this.#pending.set(interaction.interactionId, { interaction, resolve });
      this.emit({ kind: "interaction", interaction });
    });
  }
  async permission(
    turnId: HostTurnId,
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const response = await this.#ask({
      type: "approval",
      interactionId: hostInteractionIdSchema.parse(randomUUID()),
      turnId,
      title: request.toolCall.title ?? "Cursor tool approval",
      subject: { type: "nativeAction" },
      actions: request.options.map((option) => ({
        id: option.optionId,
        label: option.name,
        effect:
          option.kind === "allow_once"
            ? "allowOnce"
            : option.kind === "allow_always"
              ? "allowAlways"
              : "deny",
      })),
    });
    return response?.type === "approval"
      ? { outcome: { outcome: "selected", optionId: response.actionId } }
      : { outcome: { outcome: "cancelled" } };
  }
  async extension(
    turnId: HostTurnId,
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const interactionId = hostInteractionIdSchema.parse(randomUUID());
    if (method === "cursor/create_plan" && typeof params.plan === "string") {
      const response = await this.#ask({
        type: "approval",
        interactionId,
        turnId,
        title: typeof params.name === "string" ? params.name : "Cursor plan",
        description: params.plan,
        subject: { type: "nativeAction" },
        actions: [
          { id: "accept", label: "Accept plan", effect: "allowOnce" },
          { id: "reject", label: "Reject plan", effect: "deny" },
        ],
      });
      return {
        outcome: {
          outcome:
            response?.type === "approval"
              ? response.actionId === "accept"
                ? "accepted"
                : "rejected"
              : "cancelled",
        },
      };
    }
    if (method === "cursor/ask_question" && Array.isArray(params.questions)) {
      const questions = params.questions.map((question: unknown) => {
        if (!question || typeof question !== "object") throw new Error("Invalid Cursor question");
        const q = question as Record<string, unknown>;
        if (typeof q.id !== "string" || typeof q.prompt !== "string" || !Array.isArray(q.options))
          throw new Error("Invalid Cursor question");
        const options = q.options.map((option: unknown) => {
          if (
            !option ||
            typeof option !== "object" ||
            !("id" in option) ||
            !("label" in option) ||
            typeof option.id !== "string" ||
            typeof option.label !== "string"
          )
            throw new Error("Invalid Cursor question option");
          return { value: option.id, label: option.label };
        });
        return {
          id: q.id,
          type: "choice" as const,
          prompt: q.prompt,
          options,
          multiple: q.allowMultiple === true,
          allowOther: false,
          optional: false,
        };
      });
      const response = await this.#ask({
        type: "question",
        interactionId,
        turnId,
        questions,
        ...(typeof params.title === "string" ? { title: params.title } : {}),
      });
      return {
        outcome:
          response?.type === "question" && !response.cancelled
            ? {
                outcome: "answered",
                answers: Object.entries(response.answers).map(
                  ([questionId, selectedOptionIds]) => ({ questionId, selectedOptionIds }),
                ),
              }
            : { outcome: "cancelled" },
      };
    }
    // Unsupported blocking extensions get an explicit rejection; never imply execution.
    return {
      outcome: {
        outcome: "rejected",
        reason: "This Cursor extension is not supported by codexhost",
      },
    };
  }
  respond(command: InteractionRespondCommand): HarnessResult<InteractionRespondAccepted> {
    const pending = this.#pending.get(command.interactionId);
    const error = validateHostInteractionResponse(pending?.interaction, command.response);
    if (error || !pending)
      return {
        ok: false,
        error: error ?? {
          code: "invalidState",
          message: "Interaction is no longer pending",
          retryable: false,
        },
      };
    this.#pending.delete(command.interactionId);
    this.emit({
      kind: "event",
      event: {
        type: "interaction.closed",
        interactionId: pending.interaction.interactionId,
        turnId: pending.interaction.turnId,
        reason: "responded",
      },
    });
    pending.resolve(command.response);
    return { ok: true, value: { accepted: true } };
  }
  cancel() {
    for (const { interaction, resolve } of this.#pending.values()) {
      this.emit({
        kind: "event",
        event: {
          type: "interaction.closed",
          interactionId: interaction.interactionId,
          turnId: interaction.turnId,
          reason: "cancelled",
        },
      });
      resolve(undefined);
    }
    this.#pending.clear();
  }
}
