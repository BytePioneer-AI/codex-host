import {
  validateHostApprovalResponse,
  validateHostQuestionResponse,
  type HostApprovalEffect,
  type HostInteraction,
  type HostInteractionResponse,
} from "@codexhost/harness-adapter";
import { hostInteractionIdSchema, type HostTurnId } from "@codexhost/shared-contracts";
import { record, text } from "./protocol.js";
import { ZcodeError } from "./errors.js";

export interface PendingInteraction {
  interaction: HostInteraction;
  requestIds: Set<string | number>;
  response(value: HostInteractionResponse): unknown;
}
export function makeInteraction(
  method: string,
  params: unknown,
  turnId: HostTurnId,
  rpcId: string | number,
): PendingInteraction {
  const p = record(params),
    requestId = text(p.requestId);
  if (!requestId) throw new ZcodeError("protocolError", "ZCode interaction has no request ID");
  const interactionId = hostInteractionIdSchema.parse(`zcode:${requestId}`);
  const requestIds = new Set([rpcId]);
  if (method === "interaction/requestPermission") {
    const options = Array.isArray(p.options) ? p.options.map(record) : [];
    const actions = options.flatMap((option) => {
      const response = record(option.response);
      let effect: HostApprovalEffect;
      if (response.decision === "deny") effect = "deny";
      else if (response.decision === "allow" && !response.permissionUpdates) effect = "allowOnce";
      else if (response.decision === "allow" && option.kind === "allow_always")
        effect = "allowAlways";
      else if (response.decision === "allow" && option.kind === "allow_session")
        effect = "allowForSession";
      else return [];
      return [{ id: text(option.optionId), label: text(option.name), effect }];
    });
    if (!actions.length)
      throw new ZcodeError("unsupported", "ZCode permission options cannot be represented");
    const interaction: HostInteraction = {
      type: "approval",
      interactionId,
      turnId,
      title: text(p.toolName) || "ZCode approval",
      description: text(p.reason),
      subject: { type: "nativeAction" },
      actions,
    };
    return {
      interaction,
      requestIds,
      response(value) {
        if (value.type !== "approval")
          throw new ZcodeError("invalidRequest", "Expected an approval response");
        const error = validateHostApprovalResponse(interaction, value);
        if (error) throw new ZcodeError("invalidRequest", error.message);
        return options.find((option) => option.optionId === value.actionId)?.response;
      },
    };
  }
  const questions = Array.isArray(p.questions) ? p.questions.map(record) : [];
  const interaction: HostInteraction = {
    type: "question",
    interactionId,
    turnId,
    title: text(p.toolName) || "ZCode question",
    questions: questions.length
      ? questions.map((question, index) => ({
          id: String(index),
          type: "choice",
          prompt: text(question.question),
          options: (Array.isArray(question.options) ? question.options : []).map((value) => {
            const option = record(value);
            return {
              value: text(option.value),
              label: text(option.label),
              ...(text(option.description) ? { description: text(option.description) } : {}),
            };
          }),
          multiple: question.multiSelect === true,
          allowOther: true,
          optional: false,
        }))
      : [
          {
            id: "0",
            type: "text",
            prompt: text(p.prompt) || "Your response",
            multiline: true,
            secret: false,
            optional: false,
          },
        ],
  };
  return {
    interaction,
    requestIds,
    response(value) {
      if (value.type !== "question")
        throw new ZcodeError("invalidRequest", "Expected a question response");
      const error = validateHostQuestionResponse(interaction, value);
      if (error) throw new ZcodeError("invalidRequest", error.message);
      if (value.cancelled) return { action: "cancel" };
      return {
        action: "accept",
        content: questions.length
          ? {
              answers: Object.fromEntries(
                questions.map((question, index) => [
                  text(question.question),
                  (value.answers[String(index)] ?? []).join(", "),
                ]),
              ),
            }
          : { answer: (value.answers["0"] ?? []).join("\n") },
      };
    },
  };
}
