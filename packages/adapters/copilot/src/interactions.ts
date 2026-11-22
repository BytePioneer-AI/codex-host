import { randomUUID } from "node:crypto";
import type {
  PermissionRequest,
  PermissionRequestResult,
  SessionConfig,
} from "@github/copilot-sdk";
import {
  validateHostInteractionResponse,
  type HarnessResult,
  type HostInteraction,
  type HarnessOutput,
  type InteractionRespondCommand,
} from "@codexhost/harness-adapter";
import { hostInteractionIdSchema, type HostTurnId } from "@codexhost/shared-contracts";
import { failure } from "./errors.js";
import { elicitationForm, type ElicitationContext, type ElicitationResult } from "./elicitation.js";

type UserInputHandler = NonNullable<SessionConfig["onUserInputRequest"]>;
type UserInputRequest = Parameters<UserInputHandler>[0];
type UserInputResponse = Awaited<ReturnType<UserInputHandler>>;

interface Pending {
  interaction: HostInteraction;
  answer(command: InteractionRespondCommand): void;
  reject(error: Error): void;
  validate?(command: InteractionRespondCommand): string | undefined;
  cancelTurn?: boolean;
}

export class CopilotInteractions {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly emit: (output: HarnessOutput) => void) {}

  permission(turnId: HostTurnId, request: PermissionRequest): Promise<PermissionRequestResult> {
    const interaction: HostInteraction = {
      type: "approval",
      interactionId: hostInteractionIdSchema.parse(randomUUID()),
      turnId,
      title: `Copilot: ${request.kind}`,
      ...(request.kind === "shell" ? { description: request.fullCommandText } : {}),
      subject: { type: "nativeAction" },
      actions: [
        { id: "allow", label: "Allow once", effect: "allowOnce" },
        { id: "deny", label: "Deny", effect: "deny" },
      ],
    };
    return new Promise((resolve, reject) => {
      this.pending.set(interaction.interactionId, {
        interaction,
        reject,
        answer: ({ response }) => {
          if (response.type !== "approval") return;
          resolve({
            kind: response.actionId === "allow" ? "approved" : "denied-interactively-by-user",
          });
        },
      });
      this.emit({ kind: "interaction", interaction });
    });
  }

  question(turnId: HostTurnId, request: UserInputRequest): Promise<UserInputResponse> {
    const interaction: HostInteraction = {
      type: "question",
      interactionId: hostInteractionIdSchema.parse(randomUUID()),
      turnId,
      questions: request.choices?.length
        ? [
            {
              id: "answer",
              type: "choice",
              prompt: request.question,
              options: request.choices.map((label) => ({ value: label, label })),
              multiple: false,
              allowOther: request.allowFreeform !== false,
              optional: false,
            },
          ]
        : [
            {
              id: "answer",
              type: "text",
              prompt: request.question,
              multiline: true,
              secret: false,
              optional: false,
            },
          ],
    };
    return new Promise((resolve, reject) => {
      this.pending.set(interaction.interactionId, {
        interaction,
        cancelTurn: true,
        reject,
        answer: ({ response }) => {
          if (response.type !== "question") return;
          if (response.cancelled) {
            reject(new Error("Copilot question cancelled"));
            return;
          }
          const answer = response.answers.answer?.[0] ?? "";
          resolve({ answer, wasFreeform: !request.choices?.includes(answer) });
        },
      });
      this.emit({ kind: "interaction", interaction });
    });
  }

  respond(command: InteractionRespondCommand): HarnessResult<{ accepted: true }> {
    const pending = this.pending.get(command.interactionId);
    if (!pending) return failure("invalidRequest", "Copilot interaction is no longer active.");
    const error = validateHostInteractionResponse(pending.interaction, command.response);
    if (error) return { ok: false, error };
    const nativeValidation = pending.validate?.(command);
    if (nativeValidation) return failure("invalidRequest", nativeValidation);
    this.pending.delete(command.interactionId);
    pending.answer(command);
    this.emit({
      kind: "event",
      event: {
        type: "interaction.closed",
        interactionId: pending.interaction.interactionId,
        turnId: pending.interaction.turnId,
        reason:
          command.response.type === "question" && command.response.cancelled
            ? "cancelled"
            : "responded",
      },
    });
    return { ok: true, value: { accepted: true } };
  }

  cancelsTurn(command: InteractionRespondCommand): boolean {
    return (
      command.response.type === "question" &&
      command.response.cancelled === true &&
      this.pending.get(command.interactionId)?.cancelTurn === true
    );
  }

  elicitation(turnId: HostTurnId, context: ElicitationContext): Promise<ElicitationResult> {
    const form = elicitationForm(context);
    const interaction: HostInteraction = {
      type: "question",
      interactionId: hostInteractionIdSchema.parse(randomUUID()),
      turnId,
      title: context.message,
      questions: form.questions,
    };
    return new Promise((resolve) => {
      this.pending.set(interaction.interactionId, {
        interaction,
        reject: () => resolve({ action: "cancel" }),
        validate: ({ response }) => {
          if (response.type !== "question") return "Expected a form response.";
          try {
            form.decode(response);
            return undefined;
          } catch (error) {
            return error instanceof Error ? error.message : "Invalid form response.";
          }
        },
        answer: ({ response }) => {
          if (response.type === "question") resolve(form.decode(response));
        },
      });
      this.emit({ kind: "interaction", interaction });
    });
  }

  cancel(turnId?: HostTurnId): void {
    for (const [id, pending] of this.pending) {
      if (turnId !== undefined && pending.interaction.turnId !== turnId) continue;
      this.pending.delete(id);
      pending.reject(new Error("Copilot interaction cancelled"));
      this.emit({
        kind: "event",
        event: {
          type: "interaction.closed",
          interactionId: pending.interaction.interactionId,
          turnId: pending.interaction.turnId,
          reason: "cancelled",
        },
      });
    }
  }
}
