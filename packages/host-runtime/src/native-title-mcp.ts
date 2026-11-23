import type { JsonObject, JsonValue } from "@codexhost/protocol-core";

const MCP_SERVER_PREFIX = "mcp_servers.";
const isObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Native app-server splits override keys at each dot, without TOML quote handling.
export function mcpDisableKey(name: string): string | undefined {
  return /^[A-Za-z0-9_-]+$/u.test(name) ? `${MCP_SERVER_PREFIX}${name}.enabled` : undefined;
}

/** Flatten only the official Desktop title request's pure MCP disable table. */
export function normalizeDesktopTitleMcp(
  method: string,
  params: JsonValue | undefined,
): JsonObject | undefined {
  if (
    method !== "thread/start" ||
    !isObject(params) ||
    params.threadSource !== "thread_title" ||
    params.ephemeral !== true ||
    !isObject(params.config) ||
    !isObject(params.config.mcp_servers)
  )
    return undefined;

  const servers = params.config.mcp_servers;
  const entries = Object.entries(servers);
  if (entries.length === 0) return undefined;

  // An override for a different server (e.g. Desktop's codex_app) is independent.
  for (const key of Object.keys(params.config)) {
    if (!key.startsWith(MCP_SERVER_PREFIX)) continue;
    const name = key.slice(MCP_SERVER_PREFIX.length).split(".", 1)[0] ?? "";
    if (!name || Object.hasOwn(servers, name)) return undefined;
  }

  const config = { ...params.config };
  delete config.mcp_servers;
  for (const [name, entry] of entries) {
    const key = mcpDisableKey(name);
    if (!key || !isObject(entry) || entry.enabled !== false || Object.keys(entry).length !== 1)
      return undefined;
    config[key] = false;
  }
  return { ...params, config };
}
