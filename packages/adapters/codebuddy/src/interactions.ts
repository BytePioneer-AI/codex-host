import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import {
  validateHostInteractionResponse,
  type HarnessOutput,
  type HarnessResult,
  type HostInteraction,
  type HostQuestionInteraction,
  type InteractionRespondCommand,
} from "@codexhost/harness-adapter";
import { hostInteractionIdSchema, type HostTurnId } from "@codexhost/shared-contracts";
import type { CodeBuddyClient } from "./acp-client.js";
import { CodeBuddyError, failure, nativeError, record, rows, text } from "./common.js";

interface Pending {
  interaction: HostInteraction;
  respond(command: InteractionRespondCommand): Promise<void>;
  cancel(): void;
  responding: boolean;
}

export class CodeBuddyInteractions {
  readonly #pending = new Map<string, Pending>();
  #sequence = 0;
  constructor(
    readonly emit: (output: HarnessOutput) => void,
    readonly client: () => CodeBuddyClient,
  ) {}

  #question(turnId: HostTurnId, input: unknown): HostQuestionInteraction {
    const questions = rows(record(input).questions);
    if (!questions.length || questions.length > 4)
      throw new CodeBuddyError("protocolError", "Invalid CodeBuddy question count");
    return {
      type: "question",
      interactionId: hostInteractionIdSchema.parse(`codebuddy-question-${++this.#sequence}`),
      turnId,
      title: "CodeBuddy",
      questions: questions.map((question, index) => {
        const options = rows(question.options).map((option) => ({
          value: text(option.label),
          label: text(option.label),
          ...(option.description ? { description: text(option.description) } : {}),
        }));
        if (!text(question.question) || !options.length || options.some((option) => !option.value))
          throw new CodeBuddyError("protocolError", "Malformed CodeBuddy question");
        return {
          id: text(question.id) || `q_${index}`,
          type: "choice",
          prompt: text(question.question),
          options,
          multiple: question.multiSelect === true,
          allowOther: true,
          optional: false,
        };
      }),
    };
  }

  permission(
    turnId: HostTurnId,
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const name = text(record(request.toolCall._meta)["codebuddy.ai/toolName"]);
    if (name === "AskUserQuestion") {
      const interaction = this.#question(turnId, request.toolCall.rawInput);
      return new Promise((resolve) => {
        const cancel = () => resolve({ outcome: { outcome: "cancelled" } });
        this.#add({
          interaction,
          responding: false,
          cancel,
          respond: async (command) => {
            if (command.response.type !== "question")
              throw new CodeBuddyError("invalidRequest", "Expected a question response");
            await this.client().answer(
              request.sessionId,
              request.toolCall.toolCallId,
              command.response.cancelled ? null : command.response.answers,
            );
            cancel(); // The native extension already settled the Tool; retire the ACP permission wait.
          },
        });
      });
    }
    const actions = request.options.flatMap((option) => {
      const effect =
        option.kind === "allow_once"
          ? "allowOnce"
          : option.kind === "allow_always"
            ? "allowAlways"
            : option.kind === "reject_once" || option.kind === "reject_always"
              ? "deny"
              : undefined;
      return effect ? ([{ id: option.optionId, label: option.name, effect }] as const) : [];
    });
    if (!actions.some((action) => action.effect === "deny"))
      throw new CodeBuddyError("unsupported", "ACP approval does not provide a reject action");
    const interaction: HostInteraction = {
      type: "approval",
      interactionId: hostInteractionIdSchema.parse(`codebuddy-approval-${++this.#sequence}`),
      turnId,
      title: name || request.toolCall.title || "CodeBuddy tool approval",
      subject: { type: "nativeAction" },
      actions,
      description: JSON.stringify(request.toolCall.rawInput ?? {}).slice(0, 16_000),
    };
    return new Promise((resolve) =>
      this.#add({
        interaction,
        responding: false,
        cancel: () => resolve({ outcome: { outcome: "cancelled" } }),
        respond: async (command) => {
          if (command.response.type !== "approval")
            throw new CodeBuddyError("invalidRequest", "Expected an approval response");
          resolve({ outcome: { outcome: "selected", optionId: command.response.actionId } });
        },
      }),
    );
  }

  question(turnId: HostTurnId, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const interaction = this.#question(turnId, params.schema);
    return new Promise((resolve) =>
      this.#add({
        interaction,
        responding: false,
        cancel: () => resolve({ outcome: "cancelled" }),
        respond: async (command) => {
          if (command.response.type !== "question")
            throw new CodeBuddyError("invalidRequest", "Expected a question response");
          resolve(
            command.response.cancelled
              ? { outcome: "cancelled" }
              : { outcome: "submitted", answers: command.response.answers },
          );
        },
      }),
    );
  }

  #add(pending: Pending) {
    this.#pending.set(pending.interaction.interactionId, pending);
    this.emit({ kind: "interaction", interaction: pending.interaction });
  }

  async respond(command: InteractionRespondCommand): Promise<HarnessResult<{ accepted: true }>> {
    const pending = this.#pending.get(command.interactionId);
    if (!pending || pending.responding)
      return failure("invalidRequest", "Interaction is not awaiting a response");
    const validation = validateHostInteractionResponse(pending.interaction, command.response);
    if (validation) return { ok: false, error: validation };
    pending.responding = true;
    try {
      await pending.respond(command);
      this.#finish(pending, "responded");
      return { ok: true, value: { accepted: true } };
    } catch (error) {
      pending.responding = false;
      return { ok: false, error: nativeError(error) };
    }
  }

  #finish(pending: Pending, reason: "responded" | "cancelled") {
    if (!this.#pending.delete(pending.interaction.interactionId)) return;
    this.emit({
      kind: "event",
      event: {
        type: "interaction.closed",
        interactionId: pending.interaction.interactionId,
        turnId: pending.interaction.turnId,
        reason,
      },
    });
  }

  close() {
    for (const pending of this.#pending.values()) {
      pending.cancel();
      this.#finish(pending, "cancelled");
    }
  }
}
