import type {
  HostApprovalAction,
  HostApprovalInteraction,
  HostApprovalResponse,
} from "@codexhost/harness-adapter";
import type { JsonObject } from "@codexhost/shared-contracts";

export interface CodexApprovalRequestProjection {
  request: JsonObject;
  denyResponse: HostApprovalResponse;
  parseResponse(result: unknown): HostApprovalResponse;
}

const TITLE_MAX_LENGTH = 150;
const DESCRIPTION_MAX_LENGTH = 500;
const SERVER_NAME_MAX_LENGTH = 80;
const ELLIPSIS = "…";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: string, field: string, maxLength: number): string {
  const text = value.trim();
  if (text.length === 0 || text.length > maxLength) {
    throw new Error(`Host Approval ${field} must contain 1 to ${maxLength} characters`);
  }
  return text;
}

// Approval display text is projected, not validated: a Harness that labels a Tool Call with a long
// shell command or file path must still reach the Approval dialog. Only emptiness stays fatal.
function clampedText(value: string, field: string, maxLength: number): string {
  const text = value.trim();
  if (text.length === 0) {
    throw new Error(`Host Approval ${field} must contain at least 1 character`);
  }
  const characters = [...text];
  if (characters.length <= maxLength) return text;
  return `${characters
    .slice(0, maxLength - 1)
    .join("")
    .trimEnd()}${ELLIPSIS}`;
}

function actionsForEffect(
  interaction: HostApprovalInteraction,
  effect: HostApprovalAction["effect"],
): HostApprovalAction[] {
  return interaction.actions.filter((action) => action.effect === effect);
}

function requiredActionForEffect(
  interaction: HostApprovalInteraction,
  effect: HostApprovalAction["effect"],
): HostApprovalAction {
  const matching = actionsForEffect(interaction, effect);
  if (matching.length !== 1) {
    throw new Error(`Host Approval must declare exactly one ${effect} action`);
  }
  return matching[0] as HostApprovalAction;
}

function optionalActionForEffect(
  interaction: HostApprovalInteraction,
  effect: HostApprovalAction["effect"],
): HostApprovalAction | undefined {
  const matching = actionsForEffect(interaction, effect);
  if (matching.length > 1) {
    throw new Error(`Host Approval must declare at most one ${effect} action`);
  }
  return matching[0];
}

function validateActions(interaction: HostApprovalInteraction): void {
  const ids = new Set<string>();
  for (const action of interaction.actions) {
    if (action.id.length === 0 || action.label.trim().length === 0) {
      throw new Error("Host Approval action ID and label must be non-empty");
    }
    if (ids.has(action.id)) throw new Error("Host Approval action IDs must be unique");
    ids.add(action.id);
  }
}

function responseError(message: string): Error {
  return new Error(`Codex Approval response is invalid: ${message}`);
}

function responsePersist(value: unknown): "session" | "always" | null {
  if (value === undefined || value === null) return null;
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 1 ||
    (value.persist !== "session" && value.persist !== "always")
  ) {
    throw responseError("contains malformed persist metadata");
  }
  return value.persist;
}

export function projectCodexApprovalRequest(input: {
  threadId: string;
  interaction: HostApprovalInteraction;
  serverName: string;
}): CodexApprovalRequestProjection {
  const { interaction } = input;
  if (interaction.subject.type !== "nativeAction") {
    throw new Error("Host Approval subject is unsupported");
  }
  validateActions(interaction);
  const allow = requiredActionForEffect(interaction, "allowOnce");
  const allowForSession = optionalActionForEffect(interaction, "allowForSession");
  const allowAlways = optionalActionForEffect(interaction, "allowAlways");
  const deny = requiredActionForEffect(interaction, "deny");

  const serverName = boundedText(input.serverName, "server name", SERVER_NAME_MAX_LENGTH);
  const title = clampedText(interaction.title, "title", TITLE_MAX_LENGTH);
  const description = interaction.description
    ? clampedText(interaction.description, "description", DESCRIPTION_MAX_LENGTH)
    : undefined;
  const denyResponse: HostApprovalResponse = { type: "approval", actionId: deny.id };
  const persist = [
    ...(allowForSession ? (["session"] as const) : []),
    ...(allowAlways ? (["always"] as const) : []),
  ];
  const persistValue = persist.length === 1 ? persist[0] : persist.length > 1 ? persist : undefined;

  return {
    request: {
      method: "mcpServer/elicitation/request",
      params: {
        serverName,
        threadId: input.threadId,
        turnId: interaction.turnId,
        mode: "form",
        message: title,
        requestedSchema: { type: "object", properties: {} },
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          ...(description ? { reason: description } : {}),
          ...(persistValue ? { persist: persistValue } : {}),
        },
      },
    },
    denyResponse,
    parseResponse(result) {
      if (!isRecord(result) || typeof result.action !== "string") {
        throw responseError("missing action");
      }
      if (
        Object.keys(result).some((key) => key !== "action" && key !== "content" && key !== "_meta")
      ) {
        throw responseError("contains unreviewed fields");
      }
      const selectedPersist = responsePersist(result._meta);
      if (result.action === "accept") {
        if (
          "content" in result &&
          (!isRecord(result.content) || Object.keys(result.content).length !== 0)
        ) {
          throw responseError("contains non-empty accepted content");
        }
        if (selectedPersist === "session") {
          if (!allowForSession) throw responseError("contains an undeclared session scope");
          return { type: "approval", actionId: allowForSession.id };
        }
        if (selectedPersist === "always") {
          if (!allowAlways) throw responseError("contains an undeclared always scope");
          return { type: "approval", actionId: allowAlways.id };
        }
        return { type: "approval", actionId: allow.id };
      }
      if (result.action === "decline" || result.action === "cancel") {
        if (("content" in result && result.content !== null) || selectedPersist !== null) {
          throw responseError("contains fields incompatible with denial");
        }
        return denyResponse;
      }
      throw responseError("contains an unsupported action");
    },
  };
}
