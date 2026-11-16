/**
 * Codex Desktop hands its app tools MCP (`codex_app`, e.g. `automation_update`) a per-launch
 * pipe or socket. A Desktop reopen creates a new one, so the official backend must use the
 * value from the Desktop that is attached now.
 */
export const DESKTOP_APP_TOOLS_PIPE_ENV = "CODEX_APP_TOOLS_PIPE_PATH";

/** Desktop variables the Independent Host accepts besides codexhost's own `CODEXHOST_*` context. */
export function isDesktopContextVariable(key: string): boolean {
  return key.startsWith("CODEXHOST_") || key === DESKTOP_APP_TOOLS_PIPE_ENV;
}
