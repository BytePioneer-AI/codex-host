import {
  validateHostApprovalResponse,
  validateHostQuestionResponse,
  type HostInteraction,
  type HostEvent,
  type InteractionRespondCommand,
  type HarnessResult,
} from "@codexhost/harness-adapter";
import { hostInteractionIdSchema, type HostTurnId } from "@codexhost/shared-contracts";
import { randomUUID } from "node:crypto";
import { array, record, text, requiredText, fail, TraeError } from "./protocol.js";
import type { TraeTransport } from "./transport.js";

export class TraeInteractions {
  #pending = new Map<string, { nativeId: string | number; interaction: HostInteraction }>();
  constructor(
    readonly transport: TraeTransport,
    readonly emit: (event: HostEvent) => void,
    readonly publish: (interaction: HostInteraction) => void,
  ) {}
  request(
    method: string,
    params: Record<string, unknown>,
    nativeId: string | number,
    turnId: HostTurnId,
  ): void {
    if ([...this.#pending.values()].some((p) => p.nativeId === nativeId)) return;
    const interactionId = hostInteractionIdSchema.parse(`trae-${randomUUID()}`);
    let interaction: HostInteraction;
    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval"
    ) {
      interaction = {
        type: "approval",
        interactionId,
        turnId,
        title: text(params.command) || "Trae file changes",
        subject: { type: "nativeAction" },
        ...(text(params.reason) ? { description: text(params.reason) } : {}),
        actions: [
          { id: "accept", label: "Allow once", effect: "allowOnce" },
          { id: "acceptForSession", label: "Allow for session", effect: "allowForSession" },
          { id: "decline", label: "Deny", effect: "deny" },
        ],
      };
    } else if (method === "item/tool/requestUserInput") {
      interaction = {
        type: "question",
        interactionId,
        turnId,
        questions: array(params.questions).map((value) => {
          const q = record(value);
          const id = requiredText(q.id, "question id");
          const prompt = requiredText(q.question, "question text");
          const options = array(q.options);
          return options.length
            ? {
                id,
                type: "choice" as const,
                prompt,
                options: options.map((value) => {
                  const o = record(value);
                  return {
                    value: requiredText(o.label, "option label"),
                    label: text(o.label),
                    description: text(o.description),
                  };
                }),
                multiple: q.multiSelect === true,
                allowOther: q.isOther === true,
                optional: false,
              }
            : {
                id,
                type: "text" as const,
                prompt,
                multiline: true,
                secret: q.isSecret === true,
                optional: false,
              };
        }),
      };
      if (!interaction.questions.length)
        throw new TraeError("protocolError", "Trae question list is empty");
    } else {
      this.transport.reject(nativeId);
      return;
    }
    this.#pending.set(interactionId, { nativeId, interaction });
    this.publish(interaction);
  }
  resolved(nativeId: unknown): void {
    for (const [id, pending] of this.#pending) {
      if (pending.nativeId !== nativeId) continue;
      this.#pending.delete(id);
      this.emit({
        type: "interaction.closed",
        interactionId: pending.interaction.interactionId,
        turnId: pending.interaction.turnId,
        reason: "superseded",
      });
    }
  }
  respond(command: InteractionRespondCommand): HarnessResult<{ accepted: true }> {
    const pending = this.#pending.get(command.interactionId);
    if (!pending || pending.interaction.type !== command.response.type)
      return fail("invalidRequest", "Unknown or mismatched Trae interaction");
    let result: unknown;
    if (pending.interaction.type === "approval" && command.response.type === "approval") {
      const error = validateHostApprovalResponse(pending.interaction, command.response);
      if (error) return { ok: false, error };
      result = { decision: command.response.actionId };
    } else if (pending.interaction.type === "question" && command.response.type === "question") {
      const error = validateHostQuestionResponse(pending.interaction, command.response);
      if (error) return { ok: false, error };
      if (command.response.cancelled) this.transport.reject(pending.nativeId);
      else
        result = {
          answers: Object.fromEntries(
            Object.entries(command.response.answers).map(([id, answers]) => [id, { answers }]),
          ),
        };
    }
    if (result !== undefined) this.transport.respond(pending.nativeId, result);
    this.#pending.delete(command.interactionId);
    this.emit({
      type: "interaction.closed",
      interactionId: pending.interaction.interactionId,
      turnId: pending.interaction.turnId,
      reason: "responded",
    });
    return { ok: true, value: { accepted: true } };
  }
  cancel(turnId: HostTurnId): void {
    for (const [id, pending] of this.#pending) {
      if (pending.interaction.turnId !== turnId) continue;
      if (pending.interaction.type === "approval")
        this.transport.respond(pending.nativeId, { decision: "cancel" });
      else this.transport.reject(pending.nativeId);
      this.emit({
        type: "interaction.closed",
        interactionId: pending.interaction.interactionId,
        turnId,
        reason: "cancelled",
      });
      this.#pending.delete(id);
    }
  }
}
