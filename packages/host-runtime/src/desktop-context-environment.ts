/**
 * Codex Desktop hands its app tools MCP (`codex_app`, e.g. `automation_update`) a per-launch
 * pipe or socket. A Desktop reopen creates a new one, so the official backend must use the
 * value from the Desktop that is attached now.
 */
export const DESKTOP_APP_TOOLS_PIPE_ENV = "CODEX_APP_TOOLS_PIPE_PATH";

/** Browser access is bound to the Desktop launch, not the long-lived shared service. */
export const DESKTOP_BROWSER_ACCESS_ENV: readonly string[] = [
  "BROWSER_USE_ACCESS_EXECUTOR_ID",
  "BROWSER_USE_ACCESS_PIPE_PATH",
  "BROWSER_USE_ACCESS_VERIFYING_IDENTITY",
];

export const DESKTOP_BROWSER_MCP_ARGUMENTS_ENV = "CODEXHOST_DESKTOP_BROWSER_MCP_ARGUMENTS";
export const DESKTOP_CONTEXT_ENV: readonly string[] = [
  // Codex uses Desktop's own originator to generate native HTTP client identity.
  // Losing it lets the shared Host's first management handshake set the originator.
  "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
  DESKTOP_APP_TOOLS_PIPE_ENV,
  ...DESKTOP_BROWSER_ACCESS_ENV,
  DESKTOP_BROWSER_MCP_ARGUMENTS_ENV,
];

export function withoutDesktopContext(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => !DESKTOP_CONTEXT_ENV.includes(key)),
  );
}

/** Desktop variables the Independent Host accepts besides codexhost's own `CODEXHOST_*` context. */
export function isDesktopContextVariable(key: string): boolean {
  return key.startsWith("CODEXHOST_") || DESKTOP_CONTEXT_ENV.includes(key);
}

/** Ephemeral Desktop transport overrides are never written to native startup records. */
export function desktopBrowserMcpArguments(environment: NodeJS.ProcessEnv): string[] {
  try {
    const value: unknown = JSON.parse(environment[DESKTOP_BROWSER_MCP_ARGUMENTS_ENV] ?? "[]");
    return Array.isArray(value) && value.every((argument) => typeof argument === "string")
      ? value
      : [];
  } catch {
    return [];
  }
}
