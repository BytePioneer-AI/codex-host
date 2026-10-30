import type { FormInfo, OpenCodeClient, PermissionRequest } from "@opencode/client";
import {
  validateHostApprovalResponse,
  validateHostQuestionResponse,
  type HostInteraction,
  type HostQuestion,
  type InteractionRespondCommand,
} from "@codexhost/harness-adapter";
import { hostInteractionIdSchema, type HostTurnId } from "@codexhost/shared-contracts";

export type V2Interaction = {
  interaction: HostInteraction;
  form?: FormInfo;
  request?: PermissionRequest;
};

export function permissionInteraction(
  request: PermissionRequest,
  turnId: HostTurnId,
): V2Interaction {
  return {
    request,
    interaction: {
      type: "approval",
      interactionId: hostInteractionIdSchema.parse(`oc2-permission:${request.id}`),
      turnId,
      title: request.action,
      description: request.message ?? request.resources.join("\n"),
      subject: { type: "nativeAction" },
      actions: [
        { id: "once", label: "Allow once", effect: "allowOnce" },
        { id: "reject", label: "Deny", effect: "deny" },
      ],
    },
  };
}

export function formInteraction(form: FormInfo, turnId: HostTurnId): V2Interaction {
  const questions = form.fields.map((field): HostQuestion => {
    if (field.type === "external" || field.hidden || field.when?.length) {
      throw new Error(
        "OpenCode v2 external, hidden or conditional form fields require its native UI",
      );
    }
    const base = {
      id: field.key,
      prompt: [field.title, field.description].filter(Boolean).join("\n") || field.key,
      optional: !field.required,
    };
    if (field.type === "boolean")
      return {
        ...base,
        type: "choice",
        multiple: false,
        allowOther: false,
        options: [
          { value: "true", label: "Yes" },
          { value: "false", label: "No" },
        ],
      };
    if (field.type === "multiselect" || (field.type === "string" && field.options?.length)) {
      return {
        ...base,
        type: "choice",
        multiple: field.type === "multiselect",
        allowOther: field.custom ?? false,
        options: field.options ?? [],
      };
    }
    return {
      ...base,
      type: "text",
      multiline: field.type === "string",
      secret: false,
      ...(field.type === "string" && field.placeholder ? { placeholder: field.placeholder } : {}),
      ...(field.default !== undefined ? { prefill: String(field.default) } : {}),
    };
  });
  return {
    form,
    interaction: {
      type: "question",
      interactionId: hostInteractionIdSchema.parse(`oc2-form:${form.id}`),
      turnId,
      title: form.title,
      questions,
    },
  };
}

export async function replyInteraction(
  client: OpenCodeClient,
  pending: V2Interaction,
  command: InteractionRespondCommand,
) {
  if (pending.interaction.type === "approval" && pending.request) {
    if (command.response.type !== "approval")
      throw new Error("Expected OpenCode approval decision");
    const validation = validateHostApprovalResponse(pending.interaction, command.response);
    if (validation) throw new Error(validation.message);
    if (
      command.response.type !== "approval" ||
      !["once", "reject"].includes(command.response.actionId)
    )
      throw new Error("Invalid OpenCode approval decision");
    await client.permission.reply({
      sessionID: pending.request.sessionID,
      requestID: pending.request.id,
      decision: command.response.actionId === "once" ? "once" : "reject",
    });
    return;
  }
  if (pending.interaction.type !== "question" || !pending.form)
    throw new Error("Invalid OpenCode interaction");
  if (command.response.type !== "question") throw new Error("Expected OpenCode form answer");
  const validation = validateHostQuestionResponse(pending.interaction, command.response);
  if (validation) throw new Error(validation.message);
  const form = pending.form;
  if (command.response.cancelled) {
    await client.session.form.cancel({ sessionID: form.sessionID, formID: form.id });
    return;
  }
  const answer: Record<string, string | number | boolean | string[]> = {};
  for (const field of form.fields) {
    const values = command.response.answers[field.key] ?? [];
    if (!values.length) continue;
    const value = values[0];
    if (value === undefined) continue;
    if (field.type === "multiselect") answer[field.key] = values;
    else if (field.type === "boolean") answer[field.key] = value === "true";
    else if (field.type === "number" || field.type === "integer") {
      const number = Number(value);
      if (
        !value.trim() ||
        !Number.isFinite(number) ||
        (field.type === "integer" && !Number.isInteger(number))
      )
        throw new Error(`Invalid number for ${field.key}`);
      answer[field.key] = number;
    } else answer[field.key] = value;
  }
  await client.session.form.reply({ sessionID: form.sessionID, formID: form.id, answer });
}
