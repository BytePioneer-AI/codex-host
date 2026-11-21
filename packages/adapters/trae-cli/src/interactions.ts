import { randomUUID } from "node:crypto";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  CreateElicitationRequest,
  CreateElicitationResponse,
} from "@agentclientprotocol/sdk";
import {
  validateHostInteractionResponse,
  type HarnessOutput,
  type HostInteraction,
  type HostInteractionResponse,
  type HostQuestion,
  type InteractionRespondCommand,
} from "@codexhost/harness-adapter";
import { hostInteractionIdSchema, type HostTurnId } from "@codexhost/shared-contracts";
import { rejected, TraeCliError } from "./common.js";

export class Interactions {
  #pending = new Map<
    string,
    {
      interaction: HostInteraction;
      resolve: (response: HostInteractionResponse | undefined) => void;
    }
  >();
  constructor(readonly emit: (output: HarnessOutput) => void) {}
  #ask(interaction: HostInteraction) {
    return new Promise<HostInteractionResponse | undefined>((resolve) => {
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
      turnId,
      interactionId: hostInteractionIdSchema.parse(randomUUID()),
      title: request.toolCall.title ?? "TRAE CLI approval",
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
  async question(
    turnId: HostTurnId,
    request: CreateElicitationRequest,
  ): Promise<CreateElicitationResponse> {
    // Only the representable subset is advertised; URL and complex forms fail explicitly.
    if (request.mode !== "form" || !("requestedSchema" in request))
      throw new TraeCliError("unsupported", "TRAE CLI elicitation mode is unsupported");
    const schema = request.requestedSchema as {
      properties?: Record<string, { type?: string; title?: string; enum?: string[] }>;
      required?: string[];
    };
    if (!schema.properties)
      throw new TraeCliError("unsupported", "TRAE CLI form schema is unsupported");
    const entries = Object.entries(schema.properties);
    const questions: HostQuestion[] = entries.map(([id, property]) => {
      if (
        property.type !== "string" ||
        Object.keys(property).some((key) => !["type", "title", "description", "enum"].includes(key))
      )
        throw new TraeCliError(
          "unsupported",
          "TRAE CLI form requires an unsupported field constraint",
        );
      const common = { id, prompt: property.title ?? id, optional: !schema.required?.includes(id) };
      if (property.enum)
        return {
          ...common,
          type: "choice",
          options: property.enum.map((value) => ({ value, label: value })),
          multiple: false,
          allowOther: false,
        };
      return { ...common, type: "text", multiline: false, secret: false };
    });
    const response = await this.#ask({
      type: "question",
      interactionId: hostInteractionIdSchema.parse(randomUUID()),
      turnId,
      title: request.message,
      questions,
    });
    if (response?.type !== "question" || response.cancelled) return { action: "cancel" };
    return {
      action: "accept",
      content: Object.fromEntries(
        Object.entries(response.answers).map(([key, values]) => [key, values[0] ?? ""]),
      ),
    };
  }
  respond(command: InteractionRespondCommand) {
    const pending = this.#pending.get(command.interactionId);
    if (!pending) return rejected("invalidState", "TRAE CLI interaction is no longer pending");
    const error = validateHostInteractionResponse(pending.interaction, command.response);
    if (error) return { ok: false as const, error };
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
    return { ok: true as const, value: { accepted: true as const } };
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
