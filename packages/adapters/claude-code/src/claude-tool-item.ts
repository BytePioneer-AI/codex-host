import type {
  HostMcpToolCallItem,
  HostToolExecutionItem,
  HostWebSearchItem,
} from "@codexhost/harness-adapter";
import type { HostItemId, JsonValue } from "@codexhost/shared-contracts";

export type ClaudeToolItem = HostToolExecutionItem | HostMcpToolCallItem | HostWebSearchItem;

/**
 * Claude Code's name for an MCP server inside Tool names: invalid characters
 * become `_`, and claude.ai connectors also collapse and trim underscores.
 */
function mcpServerSegment(server: string): string {
  const segment = server.replace(/[^a-zA-Z0-9_-]/g, "_");
  return server.startsWith("claude.ai ")
    ? segment.replace(/_+/g, "_").replace(/^_|_$/g, "")
    : segment;
}

/**
 * Claude Code names MCP tools `mcp__<server>__<tool>`. Either segment may
 * contain `__`, so a server the Session reported decides the split; without
 * one, the first `__` after the server name does.
 */
function mcpTool(
  toolName: string,
  servers: readonly string[],
): { server: string; tool: string } | null {
  if (!toolName.startsWith("mcp__")) return null;
  const known = servers
    .map((server) => `mcp__${mcpServerSegment(server)}__`)
    .filter((prefix) => toolName.length > prefix.length && toolName.startsWith(prefix))
    .sort((left, right) => right.length - left.length)[0];
  if (known) return { server: known.slice(5, -2), tool: toolName.slice(known.length) };
  const [, server, ...tool] = toolName.split("__");
  const name = tool.join("__");
  return server && name ? { server, tool: name } : null;
}

/**
 * The Host Item for a non-Bash Claude Code tool call, shared by the live and
 * history paths so both present the same Item type.
 */
export function claudeToolItem(
  itemId: HostItemId,
  toolName: string,
  args: JsonValue,
  mcpServers: readonly string[] = [],
): ClaudeToolItem {
  const mcp = mcpTool(toolName, mcpServers);
  if (mcp) return { type: "mcpToolCall", itemId, ...mcp, arguments: args };
  if (
    toolName === "WebSearch" &&
    typeof args === "object" &&
    args !== null &&
    !Array.isArray(args) &&
    typeof args.query === "string" &&
    args.query.length > 0
  ) {
    return { type: "webSearch", itemId, query: args.query };
  }
  return { type: "toolExecution", itemId, toolName, arguments: args };
}
