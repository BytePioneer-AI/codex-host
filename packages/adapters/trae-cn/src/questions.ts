import {
  validateHostQuestionResponse,
  type HarnessOutput,
  type HarnessResult,
  type HostQuestionInteraction,
  type InteractionRespondAccepted,
  type InteractionRespondCommand,
} from "@codexhost/harness-adapter";
import { hostInteractionIdSchema, type HostTurnId } from "@codexhost/shared-contracts";
import type { BridgeClient } from "./bridge.js";
import { harnessError, record, TraeError } from "./errors.js";

interface PendingQuestion {
  planItemId: string;
  nativeInstanceId: string;
  definition: string;
  interaction: HostQuestionInteraction;
  responding: boolean;
}

/** Native pending Items exist only on the event stream until the task settles. */
export class QuestionInteractions {
  #pending = new Map<string, PendingQuestion>();
  #closedInstances = new Set<string>();
  constructor(
    private readonly owner: { sessionId: string; messageId: string; turnId: HostTurnId },
    private readonly client: Pick<BridgeClient, "call">,
    private readonly emit: (output: HarnessOutput) => void,
  ) {}

  observe(value: unknown): void {
    if (!record(value) || typeof value.id !== "string") return;
    if (
      typeof value.reply_to_message_id === "string" &&
      value.reply_to_message_id !== this.owner.messageId
    )
      throw new TraeError("protocolError", "Native question belongs to another Turn");
    const old = [...this.#pending.values()].find((entry) => entry.planItemId === value.id);
    const tool = record(value.tool_call_info) ? value.tool_call_info : undefined;
    const confirm = record(value.confirm_info) ? value.confirm_info : undefined;
    if (tool?.name !== "AskUserQuestion") {
      if (old) this.#close(old, "superseded");
      return;
    }
    if (confirm?.confirm_status !== "unconfirmed" || confirm.auto_confirm === true) {
      if (old) {
        const status = confirm?.confirm_status;
        const result = record(tool.result) ? tool.result.status : undefined;
        if (status === "confirmed" || result === "success") this.#close(old, "responded");
        else if (["skipped", "skipped_run", "canceled", "cancelled"].includes(String(status)))
          this.#close(old, "cancelled");
        else if (confirm?.auto_confirm === true) this.#close(old, "superseded");
        else if (["failed", "error", "canceled", "cancelled"].includes(String(result)))
          this.#close(old, "expired");
      }
      return;
    }
    if (typeof confirm.interaction_instance_id !== "string" || !confirm.interaction_instance_id)
      throw new TraeError("protocolError", "Native question has no interaction instance identity");
    if (this.#closedInstances.has(confirm.interaction_instance_id)) return;
    let params = tool.params;
    if (typeof params === "string") {
      try {
        params = JSON.parse(params) as unknown;
      } catch {
        throw new TraeError("protocolError", "Invalid native question parameters");
      }
    }
    if (!record(params) || !Array.isArray(params.questions) || !params.questions.length)
      throw new TraeError("protocolError", "Native confirmation has no questions");
    const questions = params.questions.map((question, index) => {
      if (
        !record(question) ||
        typeof question.header !== "string" ||
        typeof question.question !== "string" ||
        !question.question.trim() ||
        !Array.isArray(question.options) ||
        !question.options.length
      )
        throw new TraeError("unsupported", "Unsupported native question format");
      const options = question.options.map((option) => {
        if (!record(option) || typeof option.label !== "string" || !option.label.trim())
          throw new TraeError("protocolError", "Native question has an invalid choice");
        return {
          value: option.label,
          label: option.label,
          ...(typeof option.description === "string" ? { description: option.description } : {}),
        };
      });
      if (new Set(options.map((option) => option.value)).size !== options.length)
        throw new TraeError("protocolError", "Native question choices are ambiguous");
      return {
        id: `question-${index}`,
        type: "choice" as const,
        prompt: question.header ? `${question.header}\n${question.question}` : question.question,
        options,
        multiple: question.multiSelect === true,
        allowOther: true,
        optional: false,
      };
    });
    const definition = JSON.stringify(questions);
    if (old?.nativeInstanceId === confirm.interaction_instance_id) {
      if (old.definition !== definition)
        throw new TraeError(
          "protocolError",
          "Native question definition changed within one interaction instance",
        );
      return;
    }
    if (old) this.#close(old, "superseded");
    const interaction: HostQuestionInteraction = {
      type: "question",
      interactionId: hostInteractionIdSchema.parse(`trae-cn.${confirm.interaction_instance_id}`),
      turnId: this.owner.turnId,
      title: "需要你的选择",
      questions,
    };
    const pending = {
      planItemId: value.id,
      nativeInstanceId: confirm.interaction_instance_id,
      definition,
      interaction,
      responding: false,
    };
    this.#pending.set(interaction.interactionId, pending);
    this.emit({ kind: "interaction", interaction });
  }

  async respond(
    command: InteractionRespondCommand,
  ): Promise<HarnessResult<InteractionRespondAccepted>> {
    const pending = this.#pending.get(command.interactionId);
    if (!pending)
      return {
        ok: false,
        error: harnessError(
          new TraeError("invalidState", "This native question is no longer active"),
        ),
      };
    if (pending.responding)
      return {
        ok: false,
        error: harnessError(
          new TraeError("sessionBusy", "A response to this native question is already in progress"),
        ),
      };
    if (command.response.type !== "question")
      return {
        ok: false,
        error: harnessError(new TraeError("invalidRequest", "Expected a question response")),
      };
    const invalid = validateHostQuestionResponse(pending.interaction, command.response);
    if (invalid) return { ok: false, error: invalid };
    pending.responding = true;
    try {
      const receipt = await this.client.call("respond", {
        kind: "question",
        sessionId: this.owner.sessionId,
        messageId: this.owner.messageId,
        planItemId: pending.planItemId,
        interactionId: pending.nativeInstanceId,
        ...(command.response.cancelled
          ? { cancelled: true }
          : {
              answers: pending.interaction.questions.map((question) =>
                command.response.type === "question"
                  ? (command.response.answers[question.id] ?? [])
                  : [],
              ),
            }),
      });
      if (!record(receipt) || receipt.accepted !== true)
        throw new TraeError(
          "protocolError",
          "Native question response admission was not confirmed",
        );
      this.#close(pending, command.response.cancelled ? "cancelled" : "responded");
      return { ok: true, value: { accepted: true } };
    } catch (error) {
      return { ok: false, error: harnessError(error) };
    } finally {
      pending.responding = false;
    }
  }

  #close(
    pending: PendingQuestion,
    reason: "responded" | "cancelled" | "expired" | "superseded",
  ): void {
    if (!this.#pending.delete(pending.interaction.interactionId)) return;
    this.#closedInstances.add(pending.nativeInstanceId);
    this.emit({
      kind: "event",
      event: {
        type: "interaction.closed",
        interactionId: pending.interaction.interactionId,
        turnId: this.owner.turnId,
        reason,
      },
    });
  }

  close(reason: "cancelled" | "expired" | "superseded"): void {
    for (const pending of this.#pending.values()) this.#close(pending, reason);
  }
}
