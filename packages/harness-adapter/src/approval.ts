import type {
  HarnessError,
  HostApprovalInteraction,
  HostApprovalResponse,
} from "./text-session.js";

function invalidRequest(message: string): HarnessError {
  return { code: "invalidRequest", message, retryable: false };
}

export function validateHostApprovalResponse(
  interaction: HostApprovalInteraction,
  response: HostApprovalResponse,
): HarnessError | null {
  return interaction.actions.some(({ id }) => id === response.actionId)
    ? null
    : invalidRequest("Approval Response contains an undeclared action ID");
}
