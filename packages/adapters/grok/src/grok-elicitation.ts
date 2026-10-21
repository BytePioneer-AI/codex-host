import type { HostApprovalInteraction } from "@codexhost/harness-adapter";
import type { HostInteractionId, HostTurnId } from "@codexhost/shared-contracts";

/** JSON-RPC wire method. JS ACP SDK 1.3.0 forwards the full `_`-prefixed name to `extMethod`. */
export const GROK_MCP_ELICIT_METHOD = "_x.ai/mcp/elicit";

export const GROK_ELICIT_TITLE_MAX_LENGTH = 150;
export const GROK_ELICIT_DESCRIPTION_MAX_LENGTH = 500;

const FORM_KEYS = new Set([
  "sessionId",
  "toolCallId",
  "serverName",
  "message",
  "mode",
  "requestedSchema",
  "persist",
]);

export type GrokMcpElicitPersistScope = "session" | "always";
const URL_KEYS = new Set([
  "sessionId",
  "toolCallId",
  "serverName",
  "message",
  "mode",
  "url",
  "elicitationId",
]);
const SCHEMA_KEYS = new Set(["type", "properties", "required"]);

export type GrokMcpElicitOutcome = "accept" | "decline" | "cancel";

export interface GrokMcpElicitAcceptResponse {
  outcome: "accept";
  content: Record<string, never>;
  persist?: GrokMcpElicitPersistScope;
}

export interface GrokMcpElicitDeclineResponse {
  outcome: "decline";
}

export interface GrokMcpElicitCancelResponse {
  outcome: "cancel";
}

export type GrokMcpElicitResponse =
  GrokMcpElicitAcceptResponse | GrokMcpElicitDeclineResponse | GrokMcpElicitCancelResponse;

export interface GrokMcpElicitFormRequest {
  sessionId: string;
  toolCallId: string;
  serverName: string;
  message: string;
  mode: "form";
  persist?: GrokMcpElicitPersistScope[];
}

/** Sanitized Clock allow shape from `@oai/sky` `withComputerUsePolicy` / `createElicitation`. */
export const GROK_CLOCK_ELICIT_FIXTURE: GrokMcpElicitFormRequest = {
  sessionId: "session-1",
  toolCallId: "elicit-clock-1",
  serverName: "cua_repl",
  message: 'Allow Computer Use to use "Clock"?',
  mode: "form",
};

export const GROK_CLOCK_ELICIT_PERSIST_FIXTURE: GrokMcpElicitFormRequest = {
  ...GROK_CLOCK_ELICIT_FIXTURE,
  persist: ["session", "always"],
};

export type GrokMcpElicitParseResult =
  | { status: "form"; request: GrokMcpElicitFormRequest }
  | { status: "unsupported" }
  | { status: "invalid"; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(record).every((key) => allowed.has(key));
}

function clampText(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function parsePersistOffer(value: unknown): GrokMcpElicitPersistScope[] | "invalid" | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) return "invalid";
  let session = false;
  let always = false;
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || item !== item.trim()) return "invalid";
    if (seen.has(item)) return "invalid";
    seen.add(item);
    if (item === "session") session = true;
    else if (item === "always") always = true;
    else return "invalid";
  }
  const out: GrokMcpElicitPersistScope[] = [];
  if (session) out.push("session");
  if (always) out.push("always");
  return out.length > 0 ? out : "invalid";
}

function schemaIsSupportedEmptyObject(schema: unknown): boolean {
  if (!isRecord(schema) || !hasOnlyKeys(schema, SCHEMA_KEYS) || schema.type !== "object") {
    return false;
  }
  if (schema.properties !== undefined) {
    if (!isRecord(schema.properties) || Object.keys(schema.properties).length !== 0) return false;
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || schema.required.length !== 0) return false;
  }
  return true;
}

export function parseGrokMcpElicitParams(params: unknown): GrokMcpElicitParseResult {
  if (!isRecord(params))
    return { status: "invalid", message: "elicitation params must be an object" };
  const sessionId = nonEmptyString(params.sessionId);
  const toolCallId = nonEmptyString(params.toolCallId);
  const serverName = nonEmptyString(params.serverName);
  const message = nonEmptyString(params.message);
  if (!sessionId || !toolCallId || !serverName || !message) {
    return {
      status: "invalid",
      message: "elicitation requires sessionId, toolCallId, serverName, and message",
    };
  }
  if (params.mode === "url") {
    if (!hasOnlyKeys(params, URL_KEYS)) {
      return { status: "invalid", message: "URL elicitation contains unreviewed fields" };
    }
    if (!nonEmptyString(params.url) || !nonEmptyString(params.elicitationId)) {
      return { status: "invalid", message: "URL elicitation requires url and elicitationId" };
    }
    return { status: "unsupported" };
  }
  if (params.mode !== "form") {
    return { status: "invalid", message: "elicitation mode must be form or url" };
  }
  if (!hasOnlyKeys(params, FORM_KEYS)) {
    return { status: "invalid", message: "form elicitation contains unreviewed fields" };
  }
  if (params.requestedSchema !== undefined) {
    if (!isRecord(params.requestedSchema)) {
      return { status: "invalid", message: "requestedSchema must be an object" };
    }
    if (!schemaIsSupportedEmptyObject(params.requestedSchema)) return { status: "unsupported" };
  }
  const persist = parsePersistOffer(params.persist);
  if (persist === "invalid") {
    return {
      status: "invalid",
      message: "persist must be a unique array of session and/or always",
    };
  }
  return {
    status: "form",
    request: {
      sessionId,
      toolCallId,
      serverName,
      message,
      mode: "form",
      ...(persist ? { persist } : {}),
    },
  };
}

export function grokMcpElicitAccept(
  persist?: GrokMcpElicitPersistScope,
): GrokMcpElicitAcceptResponse {
  return { outcome: "accept", content: {}, ...(persist ? { persist } : {}) };
}

export function grokMcpElicitDecline(): GrokMcpElicitDeclineResponse {
  return { outcome: "decline" };
}

export function grokMcpElicitCancel(): GrokMcpElicitCancelResponse {
  return { outcome: "cancel" };
}

export function grokMcpElicitResponseForAction(
  effect: "allowOnce" | "allowAlways" | "deny" | "cancel",
): GrokMcpElicitResponse {
  if (effect === "allowOnce") return grokMcpElicitAccept();
  if (effect === "allowAlways") return grokMcpElicitAccept("always");
  if (effect === "deny") return grokMcpElicitDecline();
  return grokMcpElicitCancel();
}

export function grokMcpElicitApprovalActions(
  persist?: GrokMcpElicitPersistScope[],
): HostApprovalInteraction["actions"] {
  const actions: HostApprovalInteraction["actions"] = [
    { id: "allow-once", label: "Allow once", effect: "allowOnce" },
  ];
  if (persist?.includes("always")) {
    actions.push({ id: "allow-always", label: "Always allow", effect: "allowAlways" });
  }
  actions.push({ id: "deny", label: "Deny", effect: "deny" });
  return actions;
}

export function projectGrokMcpElicitApproval(input: {
  interactionId: HostInteractionId;
  turnId: HostTurnId;
  request: GrokMcpElicitFormRequest;
}): HostApprovalInteraction {
  const title = clampText(
    `${input.request.serverName}: ${input.request.message}`,
    GROK_ELICIT_TITLE_MAX_LENGTH,
  );
  const description = clampText(input.request.message, GROK_ELICIT_DESCRIPTION_MAX_LENGTH);
  return {
    type: "approval",
    interactionId: input.interactionId,
    turnId: input.turnId,
    title,
    description,
    subject: { type: "nativeAction" },
    actions: grokMcpElicitApprovalActions(input.request.persist),
  };
}

export function grokElicitationResolvedToolCallId(update: unknown): string | undefined {
  if (!isRecord(update) || update.sessionUpdate !== "interaction_resolved") return undefined;
  return nonEmptyString(update.tool_call_id) ?? nonEmptyString(update.toolCallId);
}
