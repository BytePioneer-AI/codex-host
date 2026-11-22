import { randomUUID } from "node:crypto";

import type {
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { hostInteractionIdSchema, type HostTurnId } from "@codexhost/shared-contracts";

import { readAcpToolContentText, type ProjectedElicitation } from "./projection.js";

/** Kimi Code 2.4 ACP represents plan review as distinct plan_* permission options. */
export function projectKimiPlanApprovalRequest(
  turnId: HostTurnId,
  request: RequestPermissionRequest,
):
  | (ProjectedElicitation & {
      parseResponse(response: CreateElicitationResponse): RequestPermissionResponse;
    })
  | null {
  const { options } = request;
  if (
    request.toolCall.title !== "ExitPlanMode" ||
    !options.some(({ optionId, kind }) => optionId === "plan_revise" && kind === "reject_once") ||
    !options.some(
      ({ optionId, kind }) => optionId === "plan_reject_and_exit" && kind === "reject_once",
    ) ||
    !options.some(({ kind }) => kind === "allow_once") ||
    new Set(options.map(({ optionId }) => optionId)).size !== options.length ||
    new Set(options.map(({ name }) => name)).size !== options.length ||
    !options.every(
      ({ optionId, kind, name }) =>
        name.trim().length > 0 &&
        (kind === "allow_once"
          ? optionId === "plan_approve" || /^plan_opt_\d+$/.test(optionId)
          : kind === "reject_once" &&
            (optionId === "plan_revise" || optionId === "plan_reject_and_exit")),
    )
  )
    return null;

  return {
    interaction: {
      type: "question",
      interactionId: hostInteractionIdSchema.parse(randomUUID()),
      turnId,
      title: "Kimi Code 计划审批",
      questions: [
        {
          id: "planApproval",
          type: "choice",
          prompt: readAcpToolContentText(request.toolCall.content) || "ExitPlanMode",
          options: options.map(({ optionId, name }) => ({ value: optionId, label: name })),
          multiple: false,
          allowOther: false,
          optional: false,
        },
      ],
    },
    schemaProperties: { planApproval: { type: "string" } },
    parseResponse(response) {
      const selected =
        response.action === "accept"
          ? (response.content as Record<string, unknown> | undefined)?.planApproval
          : undefined;
      return typeof selected === "string" && options.some(({ optionId }) => optionId === selected)
        ? { outcome: { outcome: "selected", optionId: selected } }
        : { outcome: { outcome: "cancelled" } };
    },
  };
}
