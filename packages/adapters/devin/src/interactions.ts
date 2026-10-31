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

export class DevinInteractions {
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
    const description = request.toolCall.content
      ?.flatMap((content) =>
        content.type === "content" && content.content.type === "text" ? [content.content.text] : [],
      )
      .join("\n");
    const response = await this.#ask({
      type: "approval",
      interactionId: hostInteractionIdSchema.parse(randomUUID()),
      turnId,
      title: request.toolCall.title ?? "Devin tool approval",
      ...(description ? { description: description.slice(0, 4_000) } : {}),
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
  /** Devin blocking extension methods are not mapped yet; fail them explicitly. */
  async extension(): Promise<Record<string, unknown>> {
    throw new Error("This Devin extension is not supported by codexhost");
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
