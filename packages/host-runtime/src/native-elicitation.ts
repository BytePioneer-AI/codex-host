import type { JsonObject, JsonValue } from "@codexhost/protocol-core";
import type { ClientInteraction } from "@codexhost/shared-contracts";

type Approval = Extract<ClientInteraction["interaction"], { type: "approval" }>;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

function persistence(params: JsonObject): string[] {
  const meta = isRecord(params._meta) ? params._meta : {};
  if (meta.codex_approval_kind !== "mcp_tool_call") return [];
  const values = Array.isArray(meta.persist) ? meta.persist : [meta.persist];
  return ["session", "always"].filter((scope) => values.includes(scope));
}

/** Empty MCP forms are consent requests; there are no question fields to answer. */
export function nativeElicitationApproval(params: JsonObject): Approval | undefined {
  if (params.mode !== undefined && params.mode !== "form") return undefined;
  const schema = isRecord(params.requestedSchema) ? params.requestedSchema : undefined;
  if (
    !schema ||
    schema.type !== "object" ||
    !isRecord(schema.properties) ||
    Object.keys(schema.properties).length !== 0 ||
    (schema.required !== undefined &&
      (!Array.isArray(schema.required) || schema.required.length !== 0))
  )
    return undefined;
  const title = text(params.message);
  if (!title) return undefined;
  const meta = isRecord(params._meta) ? params._meta : {};
  const tool = text(meta.tool_name);
  const args = isRecord(meta.tool_params) ? meta.tool_params : undefined;
  const description = [
    text(meta.reason),
    text(meta.subtitle),
    tool || args
      ? `\`\`\`json\n${JSON.stringify({ ...(tool ? { tool } : {}), ...(args ? { arguments: args } : {}) }, null, 2)}\n\`\`\``
      : undefined,
  ]
    .filter(Boolean)
    .join("\n\n");
  const scopes = persistence(params);
  return {
    type: "approval",
    title,
    ...(description ? { description } : {}),
    subject: {
      serverName: params.serverName,
      ...(tool ? { tool } : {}),
      ...(args ? { arguments: args } : {}),
    },
    actions: [
      { id: "accept", label: "Allow once", effect: "allowOnce" },
      ...(scopes.includes("session")
        ? [{ id: "acceptForSession", label: "Allow for session", effect: "allowForSession" }]
        : []),
      ...(scopes.includes("always")
        ? [{ id: "acceptAlways", label: "Always allow", effect: "allowAlways" }]
        : []),
      { id: "decline", label: "Decline", effect: "deny" },
    ],
  };
}

/** Validate consent before claiming the request; never broaden its native scope. */
export function nativeElicitationApprovalResponse(
  params: JsonObject,
  value: JsonValue,
): JsonObject {
  const invalid = (): never => {
    throw new Error(
      "Native elicitation approval response is invalid or selects an unavailable scope",
    );
  };
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !["action", "content", "_meta"].includes(key))
  )
    return invalid();
  const meta = value._meta;
  if (meta != null && (!isRecord(meta) || Object.keys(meta).length !== 1 || !("persist" in meta)))
    return invalid();
  const scope = isRecord(meta) ? meta.persist : undefined;
  if (scope !== undefined && (typeof scope !== "string" || !persistence(params).includes(scope)))
    return invalid();
  if (value.action === "accept") {
    if (
      value.content !== undefined &&
      (!isRecord(value.content) || Object.keys(value.content).length !== 0)
    )
      return invalid();
  } else if (value.action === "decline" || value.action === "cancel") {
    if (value.content != null || scope !== undefined) return invalid();
  } else return invalid();
  return value as JsonObject;
}
